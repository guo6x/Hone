/*!
 * PTY session manager using portable-pty (ConPTY on Windows, POSIX pty elsewhere).
 *
 * Spawns interactive child processes (typically `node <hone>/dist/cli.js`) bound
 * to a real pseudo-terminal so Ink-based TUIs render correctly. Output is pumped
 * over Tauri events `pty_data_<session_id>`; input is written via `pty_write`.
 */

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

pub struct PtySession {
    pub id: String,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Independent kill handle. On Windows (ConPTY), dropping the master alone
    /// sometimes leaves `node.exe` as a zombie — calling kill() here is the only
    /// reliable way to reap it. Cloned from the child before the child is moved
    /// into the reader thread.
    pub killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(
        &self,
        app: tauri::AppHandle,
        id: String,
        program: &str,
        args: Vec<String>,
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
        env: Vec<(String, String)>,
    ) -> Result<(), String> {
        // Idempotent: if a session with this id already exists, do nothing.
        // Without this, a page reload or re-mount of the XtermPanel would spawn
        // a second node.exe under the same key, orphaning the first.
        {
            let sessions = self.sessions.lock().map_err(|e| format!("lock: {}", e))?;
            if sessions.contains_key(&id) {
                log::info!("pty_open: session {} already exists, skipping spawn", id);
                return Ok(());
            }
        }
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty: {}", e))?;

        let mut cmd = CommandBuilder::new(program);
        for a in &args {
            cmd.arg(a);
        }
        if let Some(d) = cwd {
            cmd.cwd(d);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {}", e))?;
        // Drop slave so reader can EOF when the child exits.
        drop(pair.slave);

        // Take an independent killer BEFORE moving `child` into the reader thread.
        // Without this we'd have no way to reach the child from close().
        let killer = child.clone_killer();

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer: {}", e))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone_reader: {}", e))?;

        let session_id_for_thread = id.clone();
        let app_for_thread = app.clone();

        // Reader thread: pump bytes → Tauri event as Vec<u8> (we'll send as bytes JSON).
        // Using base64 to keep binary intact across JSON serialization isn't needed since
        // xterm.js can accept utf-8 strings; we lose non-utf8 bytes which is fine for Ink output.
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Best-effort utf-8; ConPTY emits utf-8 normally.
                        let s = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let _ = app_for_thread
                            .emit(&format!("pty_data_{}", session_id_for_thread), s);
                    }
                    Err(_) => break,
                }
            }
            // child has gone; wait and report exit
            let exit_code = child.wait().map(|s| s.exit_code() as i64).unwrap_or(-1);
            let _ = app_for_thread.emit(
                &format!("pty_exit_{}", session_id_for_thread),
                serde_json::json!({ "exit_code": exit_code }),
            );
        });

        let session = PtySession {
            id: id.clone(),
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
            killer: Arc::new(Mutex::new(killer)),
        };
        self.sessions
            .lock()
            .map_err(|e| format!("lock: {}", e))?
            .insert(id, session);
        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| format!("lock: {}", e))?;
        let session = sessions.get(id).ok_or_else(|| "session not found".to_string())?;
        let mut w = session.writer.lock().map_err(|e| format!("writer lock: {}", e))?;
        w.write_all(data.as_bytes()).map_err(|e| format!("write: {}", e))?;
        w.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| format!("lock: {}", e))?;
        let session = sessions.get(id).ok_or_else(|| "session not found".to_string())?;
        let master = session.master.lock().map_err(|e| format!("master lock: {}", e))?;
        master
            .resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("resize: {}", e))?;
        Ok(())
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| format!("lock: {}", e))?;
        // Explicitly kill the child via the cloned killer BEFORE dropping the session.
        // On Windows ConPTY this is the only reliable way to reap node.exe;
        // dropping the master alone leaves a zombie in some scenarios.
        if let Some(session) = sessions.remove(id) {
            if let Ok(mut k) = session.killer.lock() {
                let _ = k.kill();
            }
        }
        Ok(())
    }
}
