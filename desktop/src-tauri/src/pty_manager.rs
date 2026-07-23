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
    #[allow(dead_code)]
    pub id: String,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Independent kill handle. On Windows (ConPTY), dropping the master alone
    /// sometimes leaves `node.exe` as a zombie — calling kill() here is the only
    /// reliable way to reap it. Cloned from the child before the child is moved
    /// into the reader thread.
    pub killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    /// 直接子进程的 PID。close 时用 taskkill /T /F 递归杀整个进程树，
    /// 避免 k.kill()（只杀直接子进程）导致孙进程继续持有 pty slave 写端，
    /// reader 的 read() 不返回 EOF → reader 线程泄漏 → 孙进程变孤儿。
    pub child_pid: Option<u32>,
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
        // 持锁贯穿整个 spawn 流程，避免两个并发 open 同 id 都通过 contains_key
        // 检查后各自 spawn 一个进程，导致第一个变成孤儿（React StrictMode / 组件
        // remount / XtermPanel 快速重新打开都会触发）。
        // openpty + spawn_command 是同步的，但通常 < 50ms，不会显著阻塞其他锁竞争者。
        let mut sessions = self.sessions.lock().map_err(|e| format!("lock: {}", e))?;
        if sessions.contains_key(&id) {
            log::info!("pty_open: session {} already exists, skipping spawn", id);
            return Ok(());
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
        // 记录 PID 用于 close 时 taskkill /T 递归杀进程树
        let child_pid = child.process_id();

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
            child_pid,
        };
        sessions.insert(id, session);
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
            kill_pty_process_tree(&session);
        }
        Ok(())
    }

    /// Kill all active PTY sessions. Called on app shutdown to reap child processes.
    pub fn close_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, session) in sessions.drain() {
                kill_pty_process_tree(&session);
            }
        }
    }
}

/// 递归杀 PTY 进程树。
/// k.kill() 只杀直接子进程，孙进程会继续持有 pty slave 写端导致 reader 不返回 EOF。
/// Windows 用 taskkill /T /F 递归杀整个进程树；其他平台先 k.kill() 再用 pkill -P。
fn kill_pty_process_tree(session: &PtySession) {
    // Windows: taskkill /T /F /PID <pid> 递归杀进程树
    #[cfg(windows)]
    {
        if let Some(pid) = session.child_pid {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .output();
            return;
        }
    }
    // Unix: 先杀直接子进程，再用 pkill -P 递归杀孙进程
    #[cfg(unix)]
    {
        if let Some(pid) = session.child_pid {
            let _ = std::process::Command::new("pkill")
                .args(["-9", "-P", &pid.to_string()])
                .output();
        }
    }
    // Fallback：用 portable-pty 的 killer（只杀直接子进程）
    if let Ok(mut k) = session.killer.lock() {
        let _ = k.kill();
    }
}
