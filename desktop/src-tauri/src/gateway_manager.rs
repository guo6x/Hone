use crate::windows_git_bash;
use crate::windows_proxy;
use crate::secret_store;
use chrono::{DateTime, Utc};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::io::{BufRead, BufReader};
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;
use thiserror::Error;
use uuid::Uuid;

// ── GatewayStatus ────────────────────────────────────────────────────────

/// Lifecycle status of the Hone Gateway daemon process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum GatewayStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error(String),
}

impl std::fmt::Display for GatewayStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GatewayStatus::Stopped => write!(f, "Stopped"),
            GatewayStatus::Starting => write!(f, "Starting"),
            GatewayStatus::Running => write!(f, "Running"),
            GatewayStatus::Stopping => write!(f, "Stopping"),
            GatewayStatus::Error(e) => write!(f, "Error: {}", e),
        }
    }
}

// ── GatewayError ─────────────────────────────────────────────────────────

#[derive(Error, Debug)]
pub enum GatewayError {
    #[error("Gateway is already running")]
    AlreadyRunning,

    #[error("Gateway is not running")]
    NotRunning,

    #[error("Failed to spawn gateway process: {0}")]
    SpawnFailed(String),

    #[allow(dead_code)]
    #[error("Operation timed out")]
    Timeout,

    #[error("Process error: {0}")]
    ProcessError(String),
}

// ── GatewayConfig ────────────────────────────────────────────────────────

/// Configuration for the Gateway daemon connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayConfig {
    /// WebSocket URL of the Cloudflare Relay.
    #[serde(default = "default_relay_url")]
    pub relay_url: String,

    /// Per-install Relay room. This is public routing metadata, not a credential.
    #[serde(default = "default_relay_room")]
    pub relay_room: String,

    /// Stable identifier for the OS credential-store record.
    #[serde(default = "default_secret_id")]
    pub secret_id: String,

    /// One-time pairing challenge ID advertised to the mobile client.
    #[serde(default = "default_pairing_id")]
    pub pairing_id: String,

    /// Relay gateway credential. Stored in the OS credential store and never
    /// serialized through Tauri IPC or gateway-config.json.
    #[serde(default, skip_serializing)]
    pub relay_gateway_token: String,

    /// Capability used by the desktop WebView to authenticate to the local
    /// Gateway WebSocket. Stored in the OS credential store.
    #[serde(default, skip_serializing)]
    pub local_auth_token: String,

    /// Six-digit one-time mobile pairing code. Stored in the OS credential
    /// store; the relay only receives a derived proof during registration.
    #[serde(default, skip_serializing)]
    pub pairing_code: String,

    /// Local port the Gateway listens on.
    #[serde(default = "default_local_port")]
    pub local_port: u16,

    /// Whether to auto-start the Gateway when the app launches.
    #[serde(default = "default_true")]
    pub auto_start: bool,

    /// Directory for shared data between desktop and daemon (schedules, logs).
    #[serde(default)]
    pub data_dir: Option<String>,

    /// Explicit user project directory used for Gateway task execution.
    #[serde(default)]
    pub workspace_dir: String,

    /// Human-readable machine name sent to the relay.
    #[serde(default)]
    pub machine_name: String,

    /// AI provider (e.g. "deepseek", "openai")
    #[serde(default)]
    pub provider: String,

    /// API key for the AI provider
    #[serde(default)]
    pub api_key: String,

    /// Model name to use (e.g. "deepseek-v3", "gpt-4o")
    #[serde(default)]
    pub model: String,

    /// Custom OpenAI-compatible base URL (empty = provider default).
    #[serde(default)]
    pub base_url: String,

    /// Display name when provider == "custom".
    #[serde(default)]
    pub custom_name: String,

    /// Sampling temperature (0.0–2.0). Empty/0 = provider default.
    #[serde(default)]
    pub temperature: f32,

    /// Max output tokens (0 = provider default).
    #[serde(default)]
    pub max_tokens: u32,

    /// Enable browser automation agent
    #[serde(default)]
    pub browser_enabled: bool,

    /// GUI vision model API URL (OpenAI-compatible)
    #[serde(default)]
    pub gui_model_url: String,

    /// GUI vision model name (e.g. moonshot-v1-32k-vision-preview)
    #[serde(default)]
    pub gui_model_name: String,

    /// GUI vision model API key
    #[serde(default)]
    pub gui_model_key: String,

    /// Run browser in headless mode
    #[serde(default = "default_true")]
    pub browser_headless: bool,

    /// Max browser agent steps per task
    #[serde(default = "default_max_steps")]
    pub browser_max_steps: u32,

    /// Multi-provider profiles (2026 format). Empty = use legacy single-provider fields.
    #[serde(default)]
    pub providers: Vec<ProviderProfile>,
}

/// A single AI provider configuration (OpenAI-compatible).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub temperature: f32,
    #[serde(default)]
    pub max_tokens: u32,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub is_default: bool,
}

fn default_true() -> bool { true }
fn default_max_steps() -> u32 { 15 }

fn default_relay_url() -> String {
    "wss://hone-relay.marsailleippi79.workers.dev/connect".to_string()
}

fn default_local_port() -> u16 {
    18789
}

fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn default_relay_room() -> String { random_token() }
fn default_secret_id() -> String { Uuid::new_v4().to_string() }
fn default_pairing_id() -> String { Uuid::new_v4().to_string() }

fn default_pairing_code() -> String {
    let value = (Uuid::new_v4().as_u128() % 900_000) as u32 + 100_000;
    value.to_string()
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            relay_url: default_relay_url(),
            relay_room: default_relay_room(),
            secret_id: default_secret_id(),
            pairing_id: default_pairing_id(),
            relay_gateway_token: random_token(),
            local_auth_token: random_token(),
            pairing_code: default_pairing_code(),
            local_port: default_local_port(),
            auto_start: true,
            data_dir: None,
            workspace_dir: String::new(),
            machine_name: hostname(),
            provider: String::new(),
            api_key: String::new(),
            model: String::new(),
            base_url: String::new(),
            custom_name: String::new(),
            temperature: 0.0,
            max_tokens: 0,
            browser_enabled: false,
            gui_model_url: String::new(),
            gui_model_name: String::new(),
            gui_model_key: String::new(),
            browser_headless: true,
            browser_max_steps: 15,
            providers: Vec::new(),
        }
    }
}

/// Values needed by the trusted desktop shell to connect to its own local
/// Gateway. The Relay gateway credential is intentionally not included.
#[derive(Debug, Clone, Serialize)]
pub struct GatewayConnectionInfo {
    pub local_port: u16,
    pub local_auth_token: String,
    pub relay_url: String,
    pub relay_room: String,
    pub pairing_id: String,
    pub pairing_code: String,
    pub machine_name: String,
}

/// Best-effort hostname for the current machine.
fn hostname() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_string())
    }
}

// ── GatewayManager ───────────────────────────────────────────────────────

/// Manages the lifecycle of the Hone Gateway daemon process.
///
/// The Gateway is a long-running Node.js child process that maintains a
/// WebSocket connection to the Cloudflare Relay.  `GatewayManager` handles
/// spawn, graceful shutdown, restart, and status queries.
pub struct GatewayManager {
    pub status: GatewayStatus,
    pub process: Option<Child>,
    pub uptime: Option<DateTime<Utc>>,
    #[allow(dead_code)]
    pub version: String,
    config: GatewayConfig,
    config_path: Option<PathBuf>,
    /// 持续累积 daemon stderr 输出（保留最后 ~2000 字符），供 check_alive 在进程退出时报告原因。
    /// 同时由后台线程持续消费管道，防止 daemon 输出超 64KB 后管道满导致 write 阻塞、进程挂起。
    daemon_stderr: Arc<Mutex<String>>,
}

impl GatewayManager {
    pub fn new() -> Self {
        Self {
            status: GatewayStatus::Stopped,
            process: None,
            uptime: None,
            version: env!("CARGO_PKG_VERSION").to_string(),
            config: GatewayConfig::default(),
            config_path: None,
            daemon_stderr: Arc::new(Mutex::new(String::new())),
        }
    }

    /// Bind a config file path and load existing config from disk if present.
    /// Call once during app setup before auto-start.
    pub fn bind_config_file(&mut self, path: PathBuf) {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(cfg) = serde_json::from_slice::<GatewayConfig>(&bytes) {
                info!("Loaded gateway config from {}", path.display());
                self.config = cfg;
            } else {
                warn!("Failed to parse {}, keeping defaults", path.display());
            }
        }
        self.normalize_internal_config();
        self.hydrate_secrets();
        self.config_path = Some(path);
    }

    fn normalize_internal_config(&mut self) {
        if self.config.relay_url.trim().is_empty() {
            self.config.relay_url = default_relay_url();
        }
        // Migrate the historic globally shared room without changing a custom
        // Relay hostname. The room itself is now stored separately.
        if self.config.relay_url.trim_end_matches('/').ends_with("/connect/default") {
            self.config.relay_url = self
                .config
                .relay_url
                .trim_end_matches('/')
                .trim_end_matches("default")
                .trim_end_matches('/')
                .to_string();
        }
        if self.config.relay_room.len() < 32 {
            self.config.relay_room = default_relay_room();
        }
        if self.config.secret_id.is_empty() {
            self.config.secret_id = default_secret_id();
        }
        if self.config.pairing_id.is_empty() {
            self.config.pairing_id = default_pairing_id();
        }
        if self.config.relay_gateway_token.len() < 32 {
            self.config.relay_gateway_token = random_token();
        }
        if self.config.local_auth_token.len() < 32 {
            self.config.local_auth_token = random_token();
        }
        if self.config.pairing_code.len() != 6 || !self.config.pairing_code.chars().all(|c| c.is_ascii_digit()) {
            self.config.pairing_code = default_pairing_code();
        }
    }

    fn hydrate_secrets(&mut self) {
        let legacy_or_new = secret_store::extract(&self.config);
        match secret_store::load(&self.config.secret_id) {
            Ok(secrets) => {
                secret_store::apply(&mut self.config, &secrets);
            }
            Err(error) => {
                // First launch and migration from the old plaintext JSON share
                // this path. The current in-memory data is retained if the OS
                // vault is unavailable so a user is never silently locked out.
                if let Err(save_error) = secret_store::save(&self.config.secret_id, &legacy_or_new) {
                    warn!(
                        "Could not migrate Hone secrets to the OS credential store: {} (source: {})",
                        save_error, error
                    );
                } else {
                    info!("Migrated Hone secrets to the OS credential store");
                }
            }
        }
    }

    fn preserve_internal_security_material(&self, config: &mut GatewayConfig) {
        config.relay_room = self.config.relay_room.clone();
        config.secret_id = self.config.secret_id.clone();
        config.pairing_id = self.config.pairing_id.clone();
        config.relay_gateway_token = self.config.relay_gateway_token.clone();
        config.local_auth_token = self.config.local_auth_token.clone();
        config.pairing_code = self.config.pairing_code.clone();
    }

    fn relay_connect_url(&self, requested_url: &str) -> String {
        let mut base = if requested_url.trim().is_empty() {
            self.config.relay_url.trim().to_string()
        } else {
            requested_url.trim().to_string()
        };
        base = base.trim_end_matches('/').to_string();
        if base.ends_with("/connect/default") {
            base = base
                .trim_end_matches("default")
                .trim_end_matches('/')
                .to_string();
        }
        format!("{}/{}", base, self.config.relay_room)
    }

    fn persist(&self) {
        if let Some(p) = &self.config_path {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let secrets = secret_store::extract(&self.config);
            let mut persisted = self.config.clone();
            if let Err(error) = secret_store::save(&persisted.secret_id, &secrets) {
                warn!(
                    "Could not write Hone secrets to the OS credential store; config file will not be updated: {}",
                    error
                );
                return;
            }
            secret_store::redact(&mut persisted);
            match serde_json::to_vec_pretty(&persisted) {
                Ok(bytes) => {
                    let mut tmp_path = p.clone();
                    let mut filename = tmp_path.file_name().unwrap_or_default().to_os_string();
                    filename.push(".tmp");
                    tmp_path.set_file_name(filename);

                    let res = (|| -> Result<(), std::io::Error> {
                        use std::io::Write;
                        let mut file = std::fs::File::create(&tmp_path)?;
                        file.write_all(&bytes)?;
                        file.sync_all()?;
                        drop(file);
                        std::fs::rename(&tmp_path, p)?;
                        Ok(())
                    })();

                    if let Err(e) = res {
                        warn!("Failed to atomically persist gateway config to {}: {}", p.display(), e);
                        let _ = std::fs::remove_file(&tmp_path);
                    }
                }
                Err(e) => warn!("Failed to serialize gateway config: {}", e),
            }
        }
    }

    /// Spawn the Gateway daemon.
    ///
    /// Executes `node <hone_path>/dist/cli.js gateway start` and sets the
    /// environment variables `HONE_RELAY_URL`, `HONE_GATEWAY_PORT`, and
    /// the platform-appropriate machine-name variable.
    pub fn start(&mut self, node_path: &str, hone_path: &str, relay_url: &str) -> Result<(), GatewayError> {
        if matches!(
            self.status,
            GatewayStatus::Running | GatewayStatus::Starting
        ) {
            return Err(GatewayError::AlreadyRunning);
        }

        // 启动前清理可能残留的孤儿 Gateway 进程（桌面端崩溃后端口可能被旧进程占用）
        self.kill_orphan_gateway();

        self.normalize_internal_config();
        let relay_connect_url = self.relay_connect_url(relay_url);
        self.status = GatewayStatus::Starting;
        info!("Starting Hone Gateway (relay room: {})", self.config.relay_room);

        let mut cmd = Command::new(node_path);
        cmd.arg(format!("{}/dist/cli.js", hone_path))
            .arg("gateway")
            .arg("start")
            .env("HONE_RELAY_URL", &relay_connect_url)
            .env("HONE_AUTH_TOKEN", &self.config.relay_gateway_token)
            .env("HONE_LOCAL_AUTH_TOKEN", &self.config.local_auth_token)
            .env("HONE_PAIRING_ID", &self.config.pairing_id)
            .env("HONE_PAIRING_CODE", &self.config.pairing_code)
            .env("HONE_WORKSPACE_DIR", &self.config.workspace_dir)
            .env("HONE_GOD_MODE", "0")
            .env("HONE_GATEWAY_PORT", self.config.local_port.to_string())
            .env(
                "HONE_DATA_DIR",
                self.config
                    .data_dir
                    .clone()
                    .unwrap_or_else(|| {
                        dirs::data_dir()
                            .unwrap_or_else(|| std::path::PathBuf::from("."))
                            .join("hone-desktop")
                            .to_string_lossy()
                            .to_string()
                    }),
            );

        // 2026 multi-provider: use the default profile to override legacy fields
        if let Some(default_p) = self.config.providers.iter().find(|p| p.is_default && p.enabled) {
            if !default_p.kind.is_empty() { self.config.provider = default_p.kind.clone(); }
            if !default_p.api_key.is_empty() { self.config.api_key = default_p.api_key.clone(); }
            if !default_p.base_url.is_empty() { self.config.base_url = default_p.base_url.clone(); }
            if !default_p.model.is_empty() { self.config.model = default_p.model.clone(); }
            if default_p.temperature > 0.0 { self.config.temperature = default_p.temperature; }
            if default_p.max_tokens > 0 { self.config.max_tokens = default_p.max_tokens; }
        }

        // Pass provider settings as env vars for the CLI daemon
        // The CLI provider system reads HONE_PROVIDER to select the provider,
        // and provider-specific API key env vars (DEEPSEEK_API_KEY etc.)
        if !self.config.provider.is_empty() {
            cmd.env("HONE_PROVIDER", &self.config.provider);
        }
        if !self.config.api_key.is_empty() {
            // Map generic api_key to provider-specific env var that CLI checks
            match self.config.provider.as_str() {
                "openai" => {
                    cmd.env("OPENAI_API_KEY", &self.config.api_key);
                    if !self.config.base_url.is_empty() {
                        cmd.env("HONE_OPENAI_BASE_URL", &self.config.base_url);
                    }
                    if !self.config.model.is_empty() {
                        cmd.env("HONE_OPENAI_MODEL", &self.config.model);
                    }
                }
                "custom" => {
                    cmd.env("HONE_CUSTOM_API_KEY", &self.config.api_key);
                    if !self.config.base_url.is_empty() {
                        cmd.env("HONE_CUSTOM_BASE_URL", &self.config.base_url);
                    }
                    if !self.config.model.is_empty() {
                        cmd.env("HONE_CUSTOM_MODEL", &self.config.model);
                    }
                    if !self.config.custom_name.is_empty() {
                        cmd.env("HONE_CUSTOM_NAME", &self.config.custom_name);
                    }
                }
                _ => {
                    // deepseek (default) or unknown
                    cmd.env("DEEPSEEK_API_KEY", &self.config.api_key);
                    cmd.env("HONE_DEEPSEEK_API_KEY", &self.config.api_key);
                    if !self.config.base_url.is_empty() {
                        cmd.env("HONE_DEEPSEEK_BASE_URL", &self.config.base_url);
                    }
                    if !self.config.model.is_empty() {
                        cmd.env("HONE_DEEPSEEK_MODEL", &self.config.model);
                    }
                }
            }
        }
        if !self.config.model.is_empty() {
            cmd.env("HONE_MODEL", &self.config.model);
        }
        if self.config.temperature > 0.0 {
            cmd.env("HONE_TEMPERATURE", self.config.temperature.to_string());
        }
        if self.config.max_tokens > 0 {
            cmd.env("HONE_MAX_TOKENS", self.config.max_tokens.to_string());
        }
        // Browser automation env vars
        if self.config.browser_enabled {
            cmd.env("HONE_BROWSER_ENABLED", "true");
        }
        if !self.config.gui_model_url.is_empty() {
            cmd.env("HONE_GUI_MODEL_URL", &self.config.gui_model_url);
        }
        if !self.config.gui_model_name.is_empty() {
            cmd.env("HONE_GUI_MODEL_NAME", &self.config.gui_model_name);
        }
        if !self.config.gui_model_key.is_empty() {
            cmd.env("HONE_GUI_MODEL_KEY", &self.config.gui_model_key);
        }
        if !self.config.browser_headless {
            cmd.env("HONE_BROWSER_HEADLESS", "false");
        }
        cmd.env(
            "HONE_BROWSER_MAX_STEPS",
            self.config.browser_max_steps.to_string(),
        );
        windows_git_bash::apply_to_command(&mut cmd);
        windows_proxy::apply_to_command(&mut cmd);

        // Set the platform machine-name env var.
        #[cfg(windows)]
        {
            cmd.env("COMPUTERNAME", &self.config.machine_name);
            // Hide the console window on Windows — without this, spawning node.exe
            // pops up a cmd.exe window for the gateway daemon (and every child
            // process it later spawns), which is alarming on app startup.
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        #[cfg(not(windows))]
        {
            cmd.env("HOSTNAME", &self.config.machine_name);
        }

        // Pipe stdout/stderr so we can surface the real error message when
        // the daemon fails to start (default `Inherit` under CREATE_NO_WINDOW
        // just discards all output, leaving the user with "exited with status 1"
        // and no clue why).
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            self.status = GatewayStatus::Error(e.to_string());
            warn!("Failed to spawn gateway: {}", e);
            GatewayError::SpawnFailed(e.to_string())
        })?;

        // Give the Node.js runtime a brief moment to bootstrap, then check
        // whether the process died immediately (startup failure — e.g. wrong
        // node path, missing cli.js, syntax error). 250ms is enough to catch
        // an immediate exit without artificially slowing down every start by
        // 800ms; the daemon's actual readiness is reflected later via
        // gateway_status polling on the frontend.
        std::thread::sleep(Duration::from_millis(250));

        match child.try_wait() {
            Ok(Some(exit)) => {
                // Daemon died immediately — read stderr to give the user a
                // real error (missing module, syntax error, bad API key, etc.)
                // instead of a useless "exited with status 1".
                let mut err = String::new();
                if let Some(stderr) = child.stderr.as_mut() {
                    use std::io::Read;
                    let _ = stderr.read_to_string(&mut err);
                }
                let err = err.trim();
                let msg = if err.is_empty() {
                    format!("Gateway exited immediately with status: {}", exit)
                } else {
                    // Keep last ~500 chars to avoid huge blobs
                    let start = err.len().saturating_sub(500);
                    format!("Gateway failed to start: {}", &err[start..])
                };
                self.status = GatewayStatus::Error(msg.clone());
                warn!("{}", msg);
                Err(GatewayError::ProcessError(msg))
            }
            Ok(None) => {
                // 持续消费 stdout/stderr 管道，防止 daemon 输出超 64KB 后管道满
                // 导致 write 阻塞、进程挂起。stderr 同时累积到 daemon_stderr 供
                // check_alive 在进程退出时报告原因。
                if let Some(stderr) = child.stderr.take() {
                    let buf = self.daemon_stderr.clone();
                    // 清空上次的 stderr 缓冲
                    if let Ok(mut g) = buf.lock() { g.clear(); }
                    std::thread::spawn(move || {
                        let reader = BufReader::new(stderr);
                        for line in reader.lines().map_while(|l| l.ok()) {
                            if let Ok(mut g) = buf.lock() {
                                g.push_str(&line);
                                g.push('\n');
                                // 保留最后 ~2000 字符，避免无限增长
                                if g.len() > 4000 {
                                    let start = g.len() - 2000;
                                    let drained = g.split_off(start);
                                    *g = drained;
                                }
                            }
                        }
                    });
                }
                if let Some(stdout) = child.stdout.take() {
                    // stdout 仅消费（丢弃），防止管道满
                    std::thread::spawn(move || {
                        let reader = BufReader::new(stdout);
                        for _ in reader.lines().map_while(|l| l.ok()) {}
                    });
                }
                self.process = Some(child);
                self.uptime = Some(Utc::now());
                self.status = GatewayStatus::Running;
                info!("Gateway started successfully");
                Ok(())
            }
            Err(e) => {
                self.status = GatewayStatus::Error(e.to_string());
                warn!("Failed to check gateway health: {}", e);
                Err(GatewayError::ProcessError(e.to_string()))
            }
        }
    }

    /// Stop the Gateway daemon.
    ///
    /// On Unix the child receives SIGTERM with a 5-second grace period
    /// before SIGKILL.  On Windows `TerminateProcess` is used immediately.
    pub fn stop(&mut self) -> Result<(), GatewayError> {
        if matches!(
            self.status,
            GatewayStatus::Stopped | GatewayStatus::Stopping
        ) {
            return Err(GatewayError::NotRunning);
        }

        self.status = GatewayStatus::Stopping;
        info!("Stopping Hone Gateway");

        if let Some(mut child) = self.process.take() {
            kill_child(&mut child);
            info!("Gateway process terminated");
        }

        self.uptime = None;
        self.status = GatewayStatus::Stopped;
        Ok(())
    }

    /// Return a reference to the current lifecycle status.
    pub fn status(&self) -> &GatewayStatus {
        &self.status
    }

    /// Reap the child process if it has exited and update `status`
    /// accordingly. Without this, the status field stays `Running` forever
    /// even after the daemon crashes — which makes the frontend think the
    /// gateway is healthy and waste time trying to reach a dead relay peer.
    /// Must be called with &mut self (e.g. from `gateway_status` command).
    pub fn check_alive(&mut self) {
        if self.status != GatewayStatus::Running {
            return;
        }
        let exited = match self.process.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(_exit)) => true,
                Ok(None) => false, // still running
                Err(_) => true,    // couldn't query — treat as dead
            },
            None => true, // no process handle but status==Running → inconsistent
        };
        if exited {
            // 从后台线程累积的 stderr 缓冲中读取（管道已被持续消费，child.stderr 已 None）
            let msg = {
                let err = self.daemon_stderr.lock()
                    .map(|g| g.clone())
                    .unwrap_or_default();
                if err.trim().is_empty() {
                    "Gateway daemon process exited unexpectedly".to_string()
                } else {
                    // Keep only the last ~500 chars to avoid huge error blobs
                    let trimmed = err.trim_end();
                    let start = trimmed.len().saturating_sub(500);
                    format!("Gateway daemon exited: {}", &trimmed[start..])
                }
            };
            warn!("Gateway died: {}", msg);
            self.status = GatewayStatus::Error(msg);
            self.process = None;
            self.uptime = None;
        }
    }

    /// How long the Gateway has been running, if it is currently up.
    pub fn uptime(&self) -> Option<Duration> {
        self.uptime.map(|started| {
            let secs = (Utc::now() - started).num_seconds().max(0);
            Duration::from_secs(secs as u64)
        })
    }

    /// Stop (if running) and restart the Gateway daemon.
    #[allow(dead_code)]
    pub fn restart(&mut self, node_path: &str, hone_path: &str, relay_url: &str) -> Result<(), GatewayError> {
        info!("Restarting Hone Gateway");
        if self.is_running() {
            self.stop()?;
        }
        self.start(node_path, hone_path, relay_url)
    }

    /// Whether the Gateway is currently in the `Running` state.
    pub fn is_running(&self) -> bool {
        self.status == GatewayStatus::Running
    }

    /// 清理可能残留的孤儿 Gateway 进程。
    /// 桌面端崩溃或非正常退出后，Gateway 子进程可能仍在运行并占用端口，
    /// 导致新启动的 Gateway 无法绑定端口（EADDRINUSE）。
    fn kill_orphan_gateway(&self) {
        let port = self.config.local_port;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // 用 netstat 查找占用端口的 PID，然后 taskkill 杀掉
            if let Ok(output) = Command::new("cmd")
                .args(["/C", &format!("netstat -ano | findstr :{}", port)])
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    // 只处理 LISTENING 状态的行
                    if !line.contains("LISTENING") {
                        continue;
                    }
                    // netstat 行格式: Proto LocalAddress ForeignAddress State PID
                    // 取最后一列作为 PID
                    if let Some(pid_str) = line.split_whitespace().last() {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            // 不杀自己（当前进程）
                            if pid == std::process::id() {
                                continue;
                            }
                            log::info!("Killing orphan process on port {}: PID {}", port, pid);
                            let _ = Command::new("taskkill")
                                .args(["/T", "/F", "/PID", &pid.to_string()])
                                .creation_flags(0x08000000)
                                .output();
                            // 给系统一点时间释放端口
                            std::thread::sleep(Duration::from_millis(500));
                        }
                    }
                }
            }
        }
        #[cfg(unix)]
        {
            // Unix: 用 lsof 查找占用端口的进程
            if let Ok(output) = Command::new("lsof")
                .args(["-t", "-i", &format!("TCP:{}", port)])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for pid_str in stdout.lines() {
                    if let Ok(pid) = pid_str.trim().parse::<u32>() {
                        if pid == std::process::id() {
                            continue;
                        }
                        log::info!("Killing orphan process on port {}: PID {}", port, pid);
                        let _ = Command::new("kill")
                            .args(["-9", &pid.to_string()])
                            .output();
                        std::thread::sleep(Duration::from_millis(500));
                    }
                }
            }
        }
    }

    /// Return a clone of the current config.
    pub fn config(&self) -> GatewayConfig {
        self.config.clone()
    }

    pub fn connection_info(&self) -> GatewayConnectionInfo {
        GatewayConnectionInfo {
            local_port: self.config.local_port,
            local_auth_token: self.config.local_auth_token.clone(),
            relay_url: self.relay_connect_url(&self.config.relay_url),
            relay_room: self.config.relay_room.clone(),
            pairing_id: self.config.pairing_id.clone(),
            pairing_code: self.config.pairing_code.clone(),
            machine_name: self.config.machine_name.clone(),
        }
    }

    pub fn rotate_pairing_challenge(
        &mut self,
        node_path: &str,
        hone_path: &str,
    ) -> Result<GatewayConnectionInfo, GatewayError> {
        let was_running = self.is_running();
        if was_running {
            self.stop()?;
        }
        self.config.pairing_id = default_pairing_id();
        self.config.pairing_code = default_pairing_code();
        self.persist();
        if was_running {
            let relay = self.config.relay_url.clone();
            self.start(node_path, hone_path, &relay)?;
        }
        Ok(self.connection_info())
    }

    /// Apply a new config. If the Gateway is running, restart it with the new settings.
    /// Also persists to disk so config survives app restarts.
    pub fn apply_config(
        &mut self,
        node_path: &str,
        mut config: GatewayConfig,
        hone_path: &str,
    ) -> Result<(), GatewayError> {
        let was_running = self.is_running();
        if was_running {
            self.stop()?;
        }
        self.preserve_internal_security_material(&mut config);
        self.config = config;
        self.normalize_internal_config();
        self.persist();
        if was_running {
            let relay = self.config.relay_url.clone();
            self.start(node_path, hone_path, &relay)?;
        }
        Ok(())
    }

    /// Update config in-place without restarting. Use before first start.
    /// Also persists to disk.
    pub fn set_config(&mut self, mut config: GatewayConfig) {
        self.preserve_internal_security_material(&mut config);
        self.config = config;
        self.normalize_internal_config();
        self.persist();
    }

    /// Uptime in seconds (for IPC serialization).
    pub fn uptime_secs(&self) -> Option<u64> {
        self.uptime().map(|d| d.as_secs())
    }
}

impl Default for GatewayManager {
    fn default() -> Self {
        Self::new()
    }
}

// ── Platform-specific process termination ────────────────────────────────

#[cfg(unix)]
fn kill_child(child: &mut Child) {
    let pid = child.id();

    // Graceful shutdown via SIGTERM.
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .output();

    let deadline = Instant::now() + Duration::from_secs(5);

    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() >= deadline => {
                warn!("Gateway did not exit after SIGTERM, sending SIGKILL");
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            Ok(None) => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
}

#[cfg(windows)]
fn kill_child(child: &mut Child) {
    // 用 taskkill /T 递归终止进程树，给 daemon 及其子进程（CLI 任务等）清理机会。
    // 直接 TerminateProcess（child.kill）相当于 SIGKILL，会导致 daemon 正在写的
    // 文件（schedules.json 等）损坏，且子进程变孤儿。
    let pid = child.id();
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/T", "/PID", &pid.to_string()])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
    let _ = child.wait();
}
