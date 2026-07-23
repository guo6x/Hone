use ssh2::Session;
use std::io::Read;
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zeroize::Zeroizing;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Default local port that maps to the Hone Gateway / CLI agent port.
pub const DEFAULT_GATEWAY_PORT: u16 = 18789;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
}

/// 手动实现 Debug，跳过 auth 字段，防止密码/passphrase 意外泄漏到日志。
impl std::fmt::Debug for SshConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("auth", &"<redacted>")
            .finish()
    }
}

/// SSH 认证方式。密码使用 `Zeroizing<String>` 包装，在 drop 时自动清零内存，
/// 避免密码明文长期驻留在堆上。
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub enum SshAuth {
    Password(Zeroizing<String>),
    Key {
        path: String,
        passphrase: Option<Zeroizing<String>>,
    },
    Agent,
}

/// 手动实现 Debug，跳过敏感字段（Password / passphrase），防止泄漏到日志。
impl std::fmt::Debug for SshAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshAuth::Password(_) => f.debug_tuple("Password").field(&"<redacted>").finish(),
            SshAuth::Key { path, passphrase: _ } => f
                .debug_struct("Key")
                .field("path", path)
                .field("passphrase", &"<redacted>")
                .finish(),
            SshAuth::Agent => f.write_str("Agent"),
        }
    }
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

        // 校验服务器 host key：防止 MITM 攻击（公共 WiFi / DNS 劫持 / ARP 欺骗
        // 都可能让攻击者冒充 SSH 服务器捕获凭据）。
        // 策略：用 SHA256 指纹比对 ~/.hone/known_hosts 中该 host 的记录；
        //       存在则必须匹配，不存在则 TOFU（trust on first use）持久化。
        let fingerprint_bytes = session
            .host_key_hash(ssh2::HashType::Sha256)
            .ok_or_else(|| TunnelError::ConnectionFailed("host key hash not available".into()))?;
        let fingerprint = {
            // 转十六进制字符串持久化，避免引入 base64 依赖
            let mut s = String::with_capacity(8 + fingerprint_bytes.len() * 2);
            s.push_str("SHA256:");
            for b in fingerprint_bytes {
                s.push_str(&format!("{:02x}", b));
            }
            s
        };
        let known_hosts_path = dirs::home_dir()
            .map(|h| h.join(".hone").join("known_hosts"))
            .ok_or_else(|| TunnelError::ConnectionFailed("cannot resolve home dir".into()))?;
        std::fs::create_dir_all(known_hosts_path.parent().unwrap())
            .map_err(|e| TunnelError::ConnectionFailed(format!("create .hone dir: {}", e)))?;

        let known_hosts_content = std::fs::read_to_string(&known_hosts_path).unwrap_or_default();
        let expected_prefix = format!("{}:{} ", self.config.host, self.config.port);
        let mut found_match = false;
        let mut found_entry = false;
        for line in known_hosts_content.lines() {
            if let Some(rest) = line.strip_prefix(&expected_prefix) {
                found_entry = true;
                if rest.trim() == fingerprint {
                    found_match = true;
                    break;
                }
            }
        }
        if found_entry && !found_match {
            return Err(TunnelError::ConnectionFailed(format!(
                "Host key mismatch for {}:{} — possible MITM attack. \
                 Remove the old entry from {} if you trust the new key.",
                self.config.host, self.config.port, known_hosts_path.display()
            )));
        }
        if !found_entry {
            // TOFU: 持久化当前 host key 指纹
            let entry = format!("{}:{} {}\n", self.config.host, self.config.port, fingerprint);
            let mut content = known_hosts_content;
            if !content.ends_with('\n') && !content.is_empty() {
                content.push('\n');
            }
            content.push_str(&entry);
            std::fs::write(&known_hosts_path, content)
                .map_err(|e| TunnelError::ConnectionFailed(format!("write known_hosts: {}", e)))?;
        }

        // 设置默认超时（5 秒），覆盖 disconnect / 后续未显式设超时的操作。
        // execute_with_timeout 会临时改写并重置为 0，这里只在 connect 时设一个
        // 防御性默认值。
        session.set_timeout(5_000);

        // Authenticate
        match &self.config.auth {
            SshAuth::Password(pw) => {
                session
                    .userauth_password(&self.config.username, pw.as_str())
                    .map_err(|e| TunnelError::AuthFailed(format!("password auth: {}", e)))?;
            }
            SshAuth::Key { path, passphrase } => {
                session
                    .userauth_pubkey_file(
                        &self.config.username,
                        None,
                        std::path::Path::new(path),
                        passphrase.as_ref().map(|p| p.as_str()),
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
            // 设 3 秒超时：服务器无响应（半开连接 / 黑洞路由）时不能无限阻塞，
            // 否则应用窗口关了但进程还在，影响用户体验。
            session.set_timeout(3_000);
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
        // 30 秒超时：防止远程 tail -f / watch 等命令永久阻塞调用线程。
        // 超时后主动关闭 channel 释放 session 锁，让 Drop::drop 能正常完成。
        self.execute_with_timeout(command, std::time::Duration::from_secs(30))
    }

    /// 带超时的 SSH 命令执行。
    /// 超时后会关闭 channel 并返回错误，避免 read_to_string 永久阻塞导致
    /// session 锁无法释放、Drop::drop 无法完成的死锁问题。
    #[allow(dead_code)]
    pub fn execute_with_timeout(&self, command: &str, timeout: std::time::Duration) -> Result<String, TunnelError> {
        let session_arc = self.session.as_ref().ok_or(TunnelError::NotConnected)?;
        let session = session_arc
            .lock()
            .map_err(|_| TunnelError::Io(std::io::Error::new(std::io::ErrorKind::Other, "session lock poisoned")))?;

        // 在 session 上设置超时：ssh2 的所有阻塞 IO（含 channel.read_to_string）
        // 都受此限制。调用结束后重置为 0（无超时），避免影响后续操作。
        session.set_timeout(timeout.as_millis() as u32);

        let mut channel = session
            .channel_session()
            .map_err(|e| {
                session.set_timeout(0);
                TunnelError::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
            })?;

        channel
            .exec(command)
            .map_err(|e| {
                session.set_timeout(0);
                TunnelError::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
            })?;

        let mut output = String::new();
        match channel.read_to_string(&mut output) {
            Ok(_) => {}
            Err(e) => {
                // 超时或读取出错：主动关闭 channel，重置 session 超时，避免锁泄漏
                let _ = channel.close();
                let _ = channel.wait_close();
                session.set_timeout(0);
                return Err(TunnelError::Io(e));
            }
        }

        channel
            .wait_close()
            .map_err(|e| {
                session.set_timeout(0);
                TunnelError::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
            })?;

        session.set_timeout(0);
        Ok(output)
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        let _ = self.disconnect();
    }
}
