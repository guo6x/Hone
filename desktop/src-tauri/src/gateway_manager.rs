use crate::windows_git_bash;
use chrono::{DateTime, Utc};
use log::{info, warn};
use serde::{Deserialize, Serialize};
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
    #[serde(default)]
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
}

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
            auto_start: false,
            data_dir: None,
            machine_name: hostname(),
            provider: String::new(),
            api_key: String::new(),
            model: String::new(),
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
}

impl GatewayManager {
    pub fn new() -> Self {
        Self {
            status: GatewayStatus::Stopped,
            process: None,
            uptime: None,
            version: env!("CARGO_PKG_VERSION").to_string(),
            config: GatewayConfig::default(),
        }
    }

    /// Spawn the Gateway daemon.
    ///
    /// Executes `node <hone_path>/dist/cli.js daemon start` and sets the
    /// environment variables `HONE_RELAY_URL`, `HONE_GATEWAY_PORT`, and
    /// the platform-appropriate machine-name variable.
    pub fn start(&mut self, hone_path: &str, relay_url: &str) -> Result<(), GatewayError> {
        if matches!(
            self.status,
            GatewayStatus::Running | GatewayStatus::Starting
        ) {
            return Err(GatewayError::AlreadyRunning);
        }

        self.status = GatewayStatus::Starting;
        info!("Starting Hone Gateway (relay: {})", relay_url);

        let mut cmd = Command::new("node");
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
                }
                "custom" => {
                    cmd.env("HONE_CUSTOM_API_KEY", &self.config.api_key);
                }
                _ => {
                    // deepseek (default) or unknown
                    cmd.env("DEEPSEEK_API_KEY", &self.config.api_key);
                    cmd.env("HONE_DEEPSEEK_API_KEY", &self.config.api_key);
                }
            }
        }
        if !self.config.model.is_empty() {
            cmd.env("HONE_MODEL", &self.config.model);
        }
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
    pub fn restart(&mut self, hone_path: &str, relay_url: &str) -> Result<(), GatewayError> {
        info!("Restarting Hone Gateway");
        if self.is_running() {
            self.stop()?;
        }
        self.start(hone_path, relay_url)
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
    pub fn apply_config(
        &mut self,
        config: GatewayConfig,
        hone_path: &str,
    ) -> Result<(), GatewayError> {
        let was_running = self.is_running();
        if was_running {
            self.stop()?;
        }
        self.config = config;
        if was_running {
            let relay = self.config.relay_url.clone();
            self.start(hone_path, &relay)?;
        }
        Ok(())
    }

    /// Update config in-place without restarting. Use before first start.
    pub fn set_config(&mut self, config: GatewayConfig) {
        self.config = config;
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
