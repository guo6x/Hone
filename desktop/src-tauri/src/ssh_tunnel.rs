use ssh2::Session;
use std::io::Read;
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Default local port that maps to the Hone Gateway / CLI agent port.
pub const DEFAULT_GATEWAY_PORT: u16 = 18789;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum SshAuth {
    Password(String),
    Key {
        path: String,
        passphrase: Option<String>,
    },
    Agent,
}

#[derive(Debug, thiserror::Error)]
pub enum TunnelError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),
    #[error("Authentication failed: {0}")]
    AuthFailed(String),
    #[allow(dead_code)]
    #[error("Not connected")]
    NotConnected,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

// ---------------------------------------------------------------------------
// Tunnel
// ---------------------------------------------------------------------------

pub struct SshTunnel {
    config: SshConfig,
    // Wrapped in Arc<Mutex<..>> so the session can be shared between the
    // tunnel (for disconnect) and concurrent ssh_execute calls without being
    // "taken out" of the tunnel — which previously caused a race where a
    // second ssh_execute arriving while the first was in-flight saw
    // `session = None` and failed with "No active SSH tunnel".
    pub(crate) session: Option<Arc<Mutex<Session>>>,
    #[allow(dead_code)]
    local_port: u16,
    #[allow(dead_code)]
    remote_port: u16,
}

impl SshTunnel {
    pub fn new(config: SshConfig, local_port: u16, remote_port: u16) -> Self {
        Self {
            config,
            session: None,
            local_port,
            remote_port,
        }
    }

    // -- lifecycle ----------------------------------------------------------

    pub fn connect(&mut self) -> Result<(), TunnelError> {
        let addr = format!("{}:{}", self.config.host, self.config.port);
        let tcp = TcpStream::connect_timeout(
            &addr.parse().map_err(|e| {
                TunnelError::ConnectionFailed(format!("invalid address '{}': {}", addr, e))
            })?,
            Duration::from_secs(10),
        )
        .map_err(|e| TunnelError::ConnectionFailed(e.to_string()))?;

        let mut session = Session::new()
            .map_err(|e| TunnelError::ConnectionFailed(format!("create session: {}", e)))?;

        session.set_tcp_stream(tcp);
        session
            .handshake()
            .map_err(|e| TunnelError::ConnectionFailed(format!("handshake: {}", e)))?;

        // Authenticate
        match &self.config.auth {
            SshAuth::Password(pw) => {
                session
                    .userauth_password(&self.config.username, pw)
                    .map_err(|e| TunnelError::AuthFailed(format!("password auth: {}", e)))?;
            }
            SshAuth::Key { path, passphrase } => {
                session
                    .userauth_pubkey_file(
                        &self.config.username,
                        None,
                        std::path::Path::new(path),
                        passphrase.as_deref(),
                    )
                    .map_err(|e| TunnelError::AuthFailed(format!("key auth: {}", e)))?;
            }
            SshAuth::Agent => {
                session
                    .userauth_agent(&self.config.username)
                    .map_err(|e| TunnelError::AuthFailed(format!("agent auth: {}", e)))?;
            }
        }

        if !session.authenticated() {
            return Err(TunnelError::AuthFailed("all methods exhausted".into()));
        }

        self.session = Some(Arc::new(Mutex::new(session)));
        Ok(())
    }

    pub fn disconnect(&mut self) -> Result<(), TunnelError> {
        if let Some(session_arc) = self.session.take() {
            // Lock to ensure no in-flight command is using the session while
            // we tear it down. If the lock is poisoned, recover it — we're
            // disconnecting anyway.
            let session = session_arc
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            session
                .disconnect(None, "client disconnect", None)
                .map_err(|e| TunnelError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub fn is_connected(&self) -> bool {
        self.session.as_ref().map_or(false, |s| {
            s.lock()
                .map_or(false, |guard| guard.authenticated())
        })
    }

    // -- remote execution ---------------------------------------------------

    #[allow(dead_code)]
    pub fn execute(&self, command: &str) -> Result<String, TunnelError> {
        let session_arc = self.session.as_ref().ok_or(TunnelError::NotConnected)?;
        let session = session_arc
            .lock()
            .map_err(|_| TunnelError::Io(std::io::Error::new(std::io::ErrorKind::Other, "session lock poisoned")))?;

        let mut channel = session
            .channel_session()
            .map_err(|e| TunnelError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        channel
            .exec(command)
            .map_err(|e| TunnelError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        let mut output = String::new();
        channel
            .read_to_string(&mut output)
            .map_err(TunnelError::Io)?;

        channel
            .wait_close()
            .map_err(|e| TunnelError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        Ok(output)
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        let _ = self.disconnect();
    }
}
