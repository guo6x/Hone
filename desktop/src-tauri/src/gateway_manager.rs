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

/// Apply the default provider profile (is_default && enabled) onto the legacy
/// single-provider fields so that env vars and cli-config.json stay consistent.
pub fn apply_default_provider_profile(config: &mut GatewayConfig) {
    if let Some(default_p) = config.providers.iter().find(|p| p.is_default && p.enabled) {
        if !default_p.kind.is_empty() { config.provider = default_p.kind.clone(); }
        if !default_p.api_key.is_empty() { config.api_key = default_p.api_key.clone(); }
        if !default_p.base_url.is_empty() { config.base_url = default_p.base_url.clone(); }
        if !default_p.model.is_empty() { config.model = default_p.model.clone(); }
        if default_p.temperature > 0.0 { config.temperature = default_p.temperature; }
        if default_p.max_tokens > 0 { config.max_tokens = default_p.max_tokens; }
    }
}

/// DeepSeek 旧版/无效模型名映射到当前旗舰模型 deepseek-v4-pro。
/// - deepseek-v4 是无效名称（官方只有 v4-pro / v4-flash）
/// - deepseek-chat / deepseek-reasoner 已在 2026-07-24 废弃
fn normalize_model_name(model: &str) -> String {
    let lower = model.trim().to_ascii_lowercase();
    if lower == "deepseek-v4" || lower == "deepseek-chat" || lower == "deepseek-reasoner" {
        "deepseek-v4-pro".to_string()
    } else {
        model.to_string()
    }
}

/// Return provider-related env vars that the CLI expects.
/// Caller should call `apply_default_provider_profile` first when the effective
/// profile should override legacy fields.
pub fn provider_env_vars(config: &GatewayConfig) -> Vec<(String, String)> {
    let mut vars = Vec::new();
    // 标记 Hone 配置已由 Desktop 主动注入，后续 CLI 初始化时 managedEnv.ts
    // 会跳过 Claude Code settings.json 中的 HONE_* / DEEPSEEK_* / OPENAI_* 变量，
    // 防止 settings.json 里残留的旧 API key 覆盖当前桌面设置。
    vars.push(("HONE_CONFIG_APPLIED".to_string(), "1".to_string()));
    if !config.provider.is_empty() {
        vars.push(("HONE_PROVIDER".to_string(), config.provider.clone()));
    }
    // 只有 api_key 非空时才传递；否则 sensitive_vars 会写入空字符串到 HONE_SECRETS_FILE，
    // 导致 CLI gateway 分支用空值覆盖 cli-config.json 或凭据管理器中的有效 key。
    if !config.api_key.trim().is_empty() {
        match config.provider.as_str() {
            "openai" => {
                vars.push(("OPENAI_API_KEY".to_string(), config.api_key.clone()));
                if !config.base_url.is_empty() {
                    vars.push(("HONE_OPENAI_BASE_URL".to_string(), config.base_url.clone()));
                }
                if !config.model.is_empty() {
                    vars.push(("HONE_OPENAI_MODEL".to_string(), config.model.clone()));
                }
            }
            "custom" => {
                vars.push(("HONE_CUSTOM_API_KEY".to_string(), config.api_key.clone()));
                if !config.base_url.is_empty() {
                    vars.push(("HONE_CUSTOM_BASE_URL".to_string(), config.base_url.clone()));
                }
                if !config.model.is_empty() {
                    vars.push(("HONE_CUSTOM_MODEL".to_string(), config.model.clone()));
                }
                if !config.custom_name.is_empty() {
                    vars.push(("HONE_CUSTOM_NAME".to_string(), config.custom_name.clone()));
                }
            }
            _ => {
                vars.push(("DEEPSEEK_API_KEY".to_string(), config.api_key.clone()));
                vars.push(("HONE_DEEPSEEK_API_KEY".to_string(), config.api_key.clone()));
                if !config.base_url.is_empty() {
                    vars.push(("HONE_DEEPSEEK_BASE_URL".to_string(), config.base_url.clone()));
                }
                if !config.model.is_empty() {
                    vars.push(("HONE_DEEPSEEK_MODEL".to_string(), config.model.clone()));
                }
            }
        }
    }
    if !config.model.is_empty() {
        vars.push(("HONE_MODEL".to_string(), normalize_model_name(&config.model)));
    }
    if config.temperature > 0.0 {
        vars.push(("HONE_TEMPERATURE".to_string(), config.temperature.to_string()));
    }
    if config.max_tokens > 0 {
        vars.push(("HONE_MAX_TOKENS".to_string(), config.max_tokens.to_string()));
    }
    vars
}

fn default_true() -> bool { true }
fn default_max_steps() -> u32 { 15 }

/// 默认 relay URL。可通过 `HONE_RELAY_URL` 环境变量覆盖，
/// 用于私有部署或测试环境切换 relay 服务器，避免硬编码到代码中。
fn default_relay_url() -> String {
    if let Ok(url) = std::env::var("HONE_RELAY_URL") {
        if !url.is_empty() {
            return url;
        }
    }
    "wss://hone-relay.marsailleippi79.workers.dev/connect".to_string()
}

fn default_local_port() -> u16 {
    18789
}

fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn default_relay_room() -> String { random_token() }
fn default_secret_id() -> String {
    // Use a stable per-machine-per-user identifier so credentials survive
    // reinstalls and directory moves. Previously this was a random UUID, which
    // meant every fresh install created a new keyring record and the user's
    // saved API key appeared to disappear.
    let machine = std::env::var("COMPUTERNAME").unwrap_or_default();
    let user = std::env::var("USERNAME").unwrap_or_default();
    if machine.is_empty() && user.is_empty() {
        return Uuid::new_v4().to_string();
    }
    Uuid::new_v5(
        &Uuid::NAMESPACE_DNS,
        format!("{}@{}@hone", user, machine).as_bytes(),
    )
    .to_string()
}
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
        // 顺序很重要：先从 keyring 加载旧凭据（可能包含空的 local_auth_token），
        // 再用 normalize_internal_config 为缺失的安全字段生成新值，最后持久化。
        // 如果先 normalize 再 hydrate，keyring 中的空 token 会覆盖刚刚生成的新值。
        self.config_path = Some(path.clone());
        self.hydrate_secrets();
        self.normalize_internal_config();
        self.persist();
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

    fn persist(&mut self) {
        if let Some(p) = &self.config_path {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // 确保 keyring 中始终保存有效的 local_auth_token，避免 Desktop 前端
            // 因 token 为空而无法通过 WebSocket 认证 Gateway。
            if self.config.local_auth_token.len() < 32 {
                self.config.local_auth_token = random_token();
            }
            let secrets = secret_store::extract(&self.config);
            info!(
                "Persisting secrets: api_key_present={}, local_auth_token_len={}",
                !secrets.api_key.is_empty(),
                secrets.local_auth_token.len()
            );
            let mut persisted = self.config.clone();
            if let Err(error) = secret_store::save(&persisted.secret_id, &secrets) {
                warn!(
                    "Could not write Hone secrets to the OS credential store; config file will not be updated: {}",
                    error
                );
                return;
            }
            info!("Saved secrets to credential store for secret_id {}", persisted.secret_id);
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

        // 收集 spawn 失败时需要执行的清理动作（如删除已写入的 secrets 临时文件）。
        // spawn 成功后这些闭包不会被调用；spawn 失败或 daemon 立即退出时会逐个执行。
        let mut spawn_failure_cleanup: Vec<Box<dyn FnOnce()>> = Vec::new();

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
        apply_default_provider_profile(&mut self.config);

        // Pass provider settings as env vars for the CLI daemon.
        // 敏感变量（API Key）通过临时文件传递，避免通过环境变量泄露给子进程
        // （Linux /proc/{pid}/environ 可读、CLI 子进程继承环境变量扩大暴露面）。
        let sensitive_keys: &[&str] = &[
            "OPENAI_API_KEY",
            "HONE_OPENAI_API_KEY",
            "DEEPSEEK_API_KEY",
            "HONE_DEEPSEEK_API_KEY",
            "HONE_CUSTOM_API_KEY",
            "HONE_GUI_MODEL_KEY",
        ];
        let mut sensitive_vars: Vec<(String, String)> = Vec::new();
        for (key, value) in provider_env_vars(&self.config) {
            if sensitive_keys.contains(&key.as_str()) {
                sensitive_vars.push((key, value));
            } else {
                cmd.env(key, value);
            }
        }
        // Browser automation env vars (non-sensitive)
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
            sensitive_vars.push(("HONE_GUI_MODEL_KEY".to_string(), self.config.gui_model_key.clone()));
        }
        // 写入临时文件传递敏感凭据，避免通过环境变量暴露。
        // 临时文件在 daemon 读取后由 main.ts 的 loadSecretsFile() 立即 unlink，
        // 仅在 spawn→read 窗口期短暂存在。写入失败会自动清理。
        if !sensitive_vars.is_empty() {
            let secrets_file = std::env::temp_dir().join(format!(".hone-secrets-{}.json", uuid::Uuid::new_v4()));
            let secrets_json = serde_json::to_string(&sensitive_vars)
                .map_err(|e| GatewayError::SpawnFailed(format!("serialize secrets: {}", e)))?;
            // 写入失败时清理半成品文件，避免残留 secrets
            if let Err(e) = std::fs::write(&secrets_file, &secrets_json) {
                let _ = std::fs::remove_file(&secrets_file);
                return Err(GatewayError::SpawnFailed(format!("write secrets file: {}", e)));
            }
            // Unix: 设置 0600 权限，仅所有者可读写
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&secrets_file, std::fs::Permissions::from_mode(0o600));
            }
            cmd.env("HONE_SECRETS_FILE", secrets_file.to_string_lossy().to_string());
            // 注册 spawn 失败时的清理闭包：如果 spawn 失败，daemon 不会启动，
            // 也不会走到 main.ts 的 unlink 逻辑，需要在这里主动清理。
            spawn_failure_cleanup.push(Box::new(move || {
                let _ = std::fs::remove_file(&secrets_file);
            }));
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

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.status = GatewayStatus::Error(e.to_string());
                warn!("Failed to spawn gateway: {}", e);
                // spawn 失败时执行清理（删除已写入但 daemon 不会读取的 secrets 文件）
                for cleanup in spawn_failure_cleanup {
                    cleanup();
                }
                return Err(GatewayError::SpawnFailed(e.to_string()));
            }
        };

        // Give the Node.js runtime a brief moment to bootstrap, then check
        // whether the process died immediately (startup failure — e.g. wrong
        // node path, missing cli.js, syntax error). 100ms is enough to catch
        // an immediate exit without artificially slowing down every start by
        // 250ms; the daemon's actual readiness is reflected later via
        // gateway_status polling on the frontend.
        //
        // 锁竞争缓解：gateway_status / gateway_uptime 已改用 try_lock，不会在此
        // sleep 期间被阻塞；gateway_stop 是用户主动操作，等待 100ms 可接受。
        // 配合外层 block_in_place，tokio 其他 task 仍可被调度到别的 worker thread。
        std::thread::sleep(Duration::from_millis(100));

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
                // daemon 立即退出：daemon 不会执行 main.ts 的 unlink，需手动清理 secrets 文件
                for cleanup in spawn_failure_cleanup {
                    cleanup();
                }
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
        let port_suffix = format!(":{}", port);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // 用 netstat -ano -p TCP 列出所有 TCP 监听，在 Rust 侧精确匹配端口，
            // 避免 `findstr :18789` 子串匹配到 `:187890` / `:187891` 等误杀。
            // 某些环境（如被 TRAE 启动的 PowerShell）PATH 被截断，不包含
            // System32，因此优先使用 netstat.exe 的绝对路径；找不到再回退到 PATH。
            let netstat_paths = [
                std::path::PathBuf::from(r"C:\Windows\System32\netstat.exe"),
                std::path::PathBuf::from(r"C:\Windows\SysWOW64\netstat.exe"),
                std::path::PathBuf::from("netstat.exe"),
            ];
            let netstat_cmd = netstat_paths.iter().find(|p| p.exists()).cloned().unwrap_or_else(|| std::path::PathBuf::from("netstat.exe"));
            if let Ok(output) = Command::new(&netstat_cmd)
                .args(["-ano", "-p", "TCP"])
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
                    let cols: Vec<&str> = line.split_whitespace().collect();
                    if cols.len() < 5 {
                        continue;
                    }
                    let local_addr = cols[1];
                    // 验证本地地址确实以 :{port} 结尾（精确匹配，防止子串误杀）
                    // 同时处理 IPv4 (0.0.0.0:18789) 和 IPv6 ([::]:18789) 两种格式
                    if !local_addr.ends_with(&port_suffix) {
                        continue;
                    }
                    // 进一步验证：端口后无多余数字（防止 :187890 误匹配）
                    // local_addr 形如 "0.0.0.0:18789" 或 "[::]:18789"，分割最后一个 ':'
                    if let Some(addr_only) = local_addr.rsplit(':').next() {
                        if addr_only != port.to_string() {
                            continue;
                        }
                    }
                    // 取最后一列作为 PID
                    if let Some(pid_str) = cols.last() {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            // 不杀自己（当前进程）
                            if pid == std::process::id() {
                                continue;
                            }
                            // 验证进程映像名：只杀 node.exe / hone.exe / hone.exe，
                            // 防止用户把 localPort 设为 3306/5432/8080 时误杀 MySQL/PostgreSQL/开发服务器。
                            if !is_safe_gateway_process_windows(pid) {
                                log::warn!(
                                    "Port {} occupied by PID {} but process image is not node/hone, skipping kill",
                                    port,
                                    pid
                                );
                                continue;
                            }
                            log::info!("Killing orphan process on port {}: PID {}", port, pid);
                            let taskkill_paths = [
                                std::path::PathBuf::from(r"C:\Windows\System32\taskkill.exe"),
                                std::path::PathBuf::from(r"C:\Windows\SysWOW64\taskkill.exe"),
                                std::path::PathBuf::from("taskkill.exe"),
                            ];
                            let taskkill_cmd = taskkill_paths
                                .iter()
                                .find(|p| p.exists())
                                .cloned()
                                .unwrap_or_else(|| std::path::PathBuf::from("taskkill.exe"));
                            let _ = Command::new(&taskkill_cmd)
                                .args(["/T", "/F", "/PID", &pid.to_string()])
                                .creation_flags(0x08000000)
                                .output();
                            // 给系统时间释放端口：500ms 太短（Windows TCP stack 默认 TIME_WAIT 240s，
                            // 虽然 SO_REUSEADDR 应该能绕过，但 daemon 重启有时仍会 EADDRINUSE）。
                            // 1.5s 在慢机器上够用，又不至于让用户觉得卡顿。
                            std::thread::sleep(Duration::from_millis(1500));
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
                        // 验证进程映像名：只杀 node/hone，防止误杀其他服务
                        if !is_safe_gateway_process_unix(pid) {
                            log::warn!(
                                "Port {} occupied by PID {} but process is not node/hone, skipping kill",
                                port,
                                pid
                            );
                            continue;
                        }
                        log::info!("Killing orphan process on port {}: PID {}", port, pid);
                        let _ = Command::new("kill")
                            .args(["-9", &pid.to_string()])
                            .output();
                        // 与 Windows 端保持一致的端口释放等待时间
                        std::thread::sleep(Duration::from_millis(1500));
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
    ///
    /// 回滚策略：如果应用新配置后重启 Gateway 失败，恢复旧配置并尝试用旧配置重启，
    /// 保证用户至少能继续使用之前的可用配置，而不是处于"已停止且新配置不可用"的状态。
    pub fn apply_config(
        &mut self,
        node_path: &str,
        mut config: GatewayConfig,
        hone_path: &str,
    ) -> Result<(), GatewayError> {
        let was_running = self.is_running();
        let old_config = self.config.clone();
        if was_running {
            self.stop()?;
        }
        self.preserve_internal_security_material(&mut config);
        self.config = config;
        self.normalize_internal_config();
        self.persist();
        if was_running {
            let relay = self.config.relay_url.clone();
            match self.start(node_path, hone_path, &relay) {
                Ok(()) => {}
                Err(start_err) => {
                    // 重启失败：回滚到旧配置并尝试用旧配置重启
                    log::warn!("Gateway 重启失败，回滚到旧配置: {}", start_err);
                    self.config = old_config.clone();
                    self.persist();
                    let old_relay = old_config.relay_url.clone();
                    // 用旧配置尝试重启，如果还失败则返回原始错误
                    if let Err(rollback_err) = self.start(node_path, hone_path, &old_relay) {
                        log::error!("回滚重启也失败: {}", rollback_err);
                        return Err(start_err);
                    }
                    // 回滚成功，但仍向上层报告原始错误，让 UI 可以提示用户配置未生效
                    return Err(start_err);
                }
            }
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
    // 某些启动环境（如被 TRAE 启动的 PowerShell）PATH 被截断，不包含 System32，
    // 因此优先使用 taskkill.exe 的绝对路径；找不到再回退到 PATH。
    let pid = child.id();
    use std::os::windows::process::CommandExt;
    let taskkill_paths = [
        std::path::PathBuf::from(r"C:\Windows\System32\taskkill.exe"),
        std::path::PathBuf::from(r"C:\Windows\SysWOW64\taskkill.exe"),
        std::path::PathBuf::from("taskkill.exe"),
    ];
    let taskkill_cmd = taskkill_paths
        .iter()
        .find(|p| p.exists())
        .cloned()
        .unwrap_or_else(|| std::path::PathBuf::from("taskkill.exe"));
    let _ = Command::new(&taskkill_cmd)
        .args(["/T", "/PID", &pid.to_string()])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
    let _ = child.wait();
}

/// 验证 Windows 进程映像名是否为 Hone Gateway 相关（node.exe / hone.exe）。
/// 在按端口杀进程之前调用，防止用户把 localPort 配置成 3306/5432/8080 时
/// 误杀 MySQL/PostgreSQL/开发服务器。
#[cfg(windows)]
pub(crate) fn is_safe_gateway_process_windows(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    // 用 wmic 查询进程名。wmic 在新版 Windows 11 已弃用但默认仍可用；
    // 不可用时回退到 PowerShell Get-Process。
    if let Ok(output) = Command::new("wmic")
        .args(["process", "where", &format!("ProcessId={}", pid), "get", "Name", "/value"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
        // wmic 输出形如 "Name=node.exe\r\n"
        for line in stdout.lines() {
            if let Some(name) = line.trim().strip_prefix("name=") {
                let name = name.trim();
                return name == "node.exe" || name == "hone.exe";
            }
        }
    }
    // 查询失败时保守返回 false：宁可漏杀孤儿进程（用户可手动处理），
    // 不可误杀用户其他服务。
    false
}

/// 验证 Unix 进程映像名是否为 Hone Gateway 相关（node / hone）。
#[cfg(unix)]
pub(crate) fn is_safe_gateway_process_unix(pid: u32) -> bool {
    // 用 ps -p PID -o comm= 查询进程名
    if let Ok(output) = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
    {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // comm= 可能返回带路径或仅基名，统一取最后一段
        let basename = name.rsplit('/').next().unwrap_or(&name);
        return basename == "node" || basename == "hone";
    }
    // 查询失败时保守返回 false
    false
}
