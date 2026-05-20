use crate::windows_git_bash;
use chrono::{DateTime, Utc};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;
use thiserror::Error;

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

    /// Local port the Gateway listens on.
    #[serde(default = "default_local_port")]
    pub local_port: u16,

    /// Whether to auto-start the Gateway when the app launches.
    #[serde(default = "default_true")]
    pub auto_start: bool,

    /// Directory for shared data between desktop and daemon (schedules, logs).
    #[serde(default)]
    pub data_dir: Option<String>,

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
}

fn default_true() -> bool { true }
fn default_max_steps() -> u32 { 15 }

fn default_relay_url() -> String {
    "wss://hone-relay.marsailleippi79.workers.dev/connect/default".to_string()
}

fn default_local_port() -> u16 {
    18789
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            relay_url: default_relay_url(),
            local_port: default_local_port(),
            auto_start: true,
            data_dir: None,
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
        }
    }
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
    pub version: String,
    config: GatewayConfig,
    config_path: Option<PathBuf>,
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
        self.config_path = Some(path);
    }

    fn persist(&self) {
        if let Some(p) = &self.config_path {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match serde_json::to_vec_pretty(&self.config) {
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
    /// Executes `node <hone_path>/dist/cli.js daemon start` and sets the
    /// environment variables `HONE_RELAY_URL`, `HONE_GATEWAY_PORT`, and
    /// the platform-appropriate machine-name variable.
    pub fn start(&mut self, node_path: &str, hone_path: &str, relay_url: &str) -> Result<(), GatewayError> {
        if matches!(
            self.status,
            GatewayStatus::Running | GatewayStatus::Starting
        ) {
            return Err(GatewayError::AlreadyRunning);
        }

        self.status = GatewayStatus::Starting;
        info!("Starting Hone Gateway (relay: {})", relay_url);

        let mut cmd = Command::new(node_path);
        cmd.arg(format!("{}/dist/cli.js", hone_path))
            .arg("gateway")
            .arg("start")
            .env("HONE_RELAY_URL", relay_url)
            .env("HONE_GOD_MODE", "1")
            .env("HONE_GATEWAY_PORT", self.config.local_port.to_string())
            .env(
                "HONE_DATA_DIR",
                dirs::data_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join("hone-desktop")
                    .to_string_lossy()
                    .to_string(),
            );

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

        // Set the platform machine-name env var.
        #[cfg(windows)]
        {
            cmd.env("COMPUTERNAME", &self.config.machine_name);
        }
        #[cfg(not(windows))]
        {
            cmd.env("HOSTNAME", &self.config.machine_name);
        }

        let mut child = cmd.spawn().map_err(|e| {
            self.status = GatewayStatus::Error(e.to_string());
            warn!("Failed to spawn gateway: {}", e);
            GatewayError::SpawnFailed(e.to_string())
        })?;

        // Give the Node.js runtime a moment to bootstrap, then check
        // whether the process died immediately (startup failure).
        std::thread::sleep(Duration::from_millis(800));

        match child.try_wait() {
            Ok(Some(exit)) => {
                let msg = format!("Gateway exited immediately with status: {}", exit);
                self.status = GatewayStatus::Error(msg.clone());
                warn!("{}", msg);
                Err(GatewayError::ProcessError(msg))
            }
            Ok(None) => {
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

    /// How long the Gateway has been running, if it is currently up.
    pub fn uptime(&self) -> Option<Duration> {
        self.uptime.map(|started| {
            let secs = (Utc::now() - started).num_seconds().max(0);
            Duration::from_secs(secs as u64)
        })
    }

    /// Stop (if running) and restart the Gateway daemon.
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

    /// Return a clone of the current config.
    pub fn config(&self) -> GatewayConfig {
        self.config.clone()
    }

    /// Apply a new config. If the Gateway is running, restart it with the new settings.
    /// Also persists to disk so config survives app restarts.
    pub fn apply_config(
        &mut self,
        node_path: &str,
        config: GatewayConfig,
        hone_path: &str,
    ) -> Result<(), GatewayError> {
        let was_running = self.is_running();
        if was_running {
            self.stop()?;
        }
        self.config = config;
        self.persist();
        if was_running {
            let relay = self.config.relay_url.clone();
            self.start(node_path, hone_path, &relay)?;
        }
        Ok(())
    }

    /// Update config in-place without restarting. Use before first start.
    /// Also persists to disk.
    pub fn set_config(&mut self, config: GatewayConfig) {
        self.config = config;
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
    let _ = child.kill();
    let _ = child.wait();
}
