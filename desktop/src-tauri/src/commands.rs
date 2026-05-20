use std::sync::Mutex;
use tauri::{Manager, State};

use crate::gateway_manager::{GatewayConfig, GatewayManager, GatewayStatus};
use crate::machine_registry::{MachineInfo, MachineRegistry, MachineStatus};
use crate::mdns_discovery::{DiscoveredGateway, MdnsDiscovery};
use crate::ssh_tunnel::{SshConfig, SshTunnel, DEFAULT_GATEWAY_PORT};
use tauri_plugin_autostart::ManagerExt;

pub struct AppState {
    pub gateway: Mutex<GatewayManager>,
    pub registry: Mutex<MachineRegistry>,
    pub discovery: Mutex<MdnsDiscovery>,
    pub ssh: Mutex<Option<SshTunnel>>,
    pub hone_path: Mutex<Option<String>>,
    pub pty: crate::pty_manager::PtyManager,
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use std::path::PathBuf;
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&data_dir).map_err(|e| {
        log::warn!("Could not create app data directory: {}", e);
        e
    });

    // Try to guess the hone project root from the executable location
    let hone_path = guess_hone_path(app);

    // Bind the gateway config to disk so user settings (API key, model, etc.)
    // survive app restarts. Without this every relaunch loses everything.
    let mut gateway = GatewayManager::new();
    gateway.bind_config_file(data_dir.join("gateway-config.json"));

    app.manage(AppState {
        gateway: Mutex::new(gateway),
        registry: Mutex::new(MachineRegistry::new(data_dir.join("machines.json"))),
        discovery: Mutex::new(MdnsDiscovery::new()),
        ssh: Mutex::new(None),
        hone_path: Mutex::new(hone_path.clone()),
        pty: crate::pty_manager::PtyManager::new(),
    });

    // Spawn the background scheduler
    if let Some(path) = hone_path {
        let handle = app.handle().clone();
        crate::scheduler::spawn(handle, path, None);
    }

    Ok(())
}

/// Attempt to locate the hone project root directory.
fn guess_hone_path(app: &tauri::App) -> Option<String> {
    // 1. Try relative to current executable, going up to 5 levels
    if let Ok(exe_path) = std::env::current_exe() {
        let mut curr = exe_path.as_path();
        for _ in 0..5 {
            if let Some(parent) = curr.parent() {
                if parent.join("dist").join("cli.js").exists() {
                    log::info!("Detected Hone path from exe ancestor: {}", parent.display());
                    return Some(parent.to_string_lossy().to_string());
                }
                curr = parent;
            } else {
                break;
            }
        }
    }

    // 2. Check current working directory, going up to 5 levels
    if let Ok(cwd) = std::env::current_dir() {
        let mut curr = cwd.as_path();
        for _ in 0..5 {
            if curr.join("dist").join("cli.js").exists() {
                log::info!("Detected Hone path from cwd ancestor: {}", curr.display());
                return Some(curr.to_string_lossy().to_string());
            }
            if let Some(parent) = curr.parent() {
                curr = parent;
            } else {
                break;
            }
        }
    }

    // 3. Try relative to resource_dir
    if let Ok(res_dir) = app.path().resource_dir() {
        if res_dir.join("dist").join("cli.js").exists() {
            log::info!("Detected Hone path from resource_dir: {}", res_dir.display());
            return Some(res_dir.to_string_lossy().to_string());
        }
        let res_sub = res_dir.join("resources");
        if res_sub.join("dist").join("cli.js").exists() {
            log::info!("Detected Hone path from resource_dir/resources: {}", res_sub.display());
            return Some(res_sub.to_string_lossy().to_string());
        }
    }

    None
}

/// Resolve the correct Node.js binary path.
/// If a bundled Node.js is present under resource_dir, we prefer it;
/// otherwise we fallback to the system 'node'.
fn get_node_path(app: &tauri::AppHandle) -> String {
    if let Ok(res_dir) = app.path().resource_dir() {
        let paths = [
            res_dir.join("resources").join("node").join("node.exe"),
            res_dir.join("node").join("node.exe"),
            res_dir.join("resources").join("node").join("node"),
            res_dir.join("node").join("node"),
        ];

        for p in &paths {
            if p.exists() {
                log::info!("Using bundled Node runtime: {}", p.display());
                return p.to_string_lossy().to_string();
            }
        }
    }

    log::info!("Bundled Node runtime not found, falling back to system 'node'");
    "node".to_string()
}

// ── Gateway Commands ──

#[tauri::command]
pub async fn gateway_start(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    hone_path: String,
    relay_url: Option<String>,
) -> Result<String, String> {
    log::info!(
        "gateway_start called, hone_path={}, relay_url={:?}",
        hone_path,
        relay_url
    );

    // Persist hone_path for the scheduler
    {
        let mut path = state
            .hone_path
            .lock()
            .map_err(|e| format!("Failed to acquire hone_path lock: {}", e))?;
        if path.is_none() {
            *path = Some(hone_path.clone());
        }
    }

    // Ensure the data_dir is set on the config
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    let mut gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;

    // Set data_dir on config before spawning the daemon
    {
        let mut cfg = gw.config();
        cfg.data_dir = Some(data_dir.to_string_lossy().to_string());
        gw.set_config(cfg);
    }

    let url = relay_url.unwrap_or_else(|| "wss://hone-relay.marsailleippi79.workers.dev/connect/default".into());

    // Validation: ensure the path exists and contains dist/cli.js
    let p = std::path::Path::new(&hone_path);
    if !p.exists() {
        return Err(format!("Hone path does not exist: {}", hone_path));
    }
    if !p.join("dist").join("cli.js").exists() {
        return Err(format!(
            "Invalid Hone path: {}/dist/cli.js not found",
            hone_path
        ));
    }

    let node_path = get_node_path(&app);
    gw.start(&node_path, &hone_path, &url)
        .map(|()| format!("Gateway started: {}", url))
        .map_err(|e| format!("Failed to start gateway: {}", e))
}

#[tauri::command]
pub async fn gateway_stop(state: State<'_, AppState>) -> Result<String, String> {
    log::info!("gateway_stop called");

    let mut gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;

    gw.stop()
        .map(|()| "Gateway stopped".to_string())
        .map_err(|e| format!("Failed to stop gateway: {}", e))
}

#[tauri::command]
pub async fn gateway_status(state: State<'_, AppState>) -> Result<GatewayStatus, String> {
    log::info!("gateway_status called");

    let gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;

    Ok(gw.status().clone())
}

#[tauri::command]
pub async fn gateway_uptime(state: State<'_, AppState>) -> Result<Option<u64>, String> {
    log::info!("gateway_uptime called");

    let gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;

    Ok(gw.uptime_secs())
}

// ── Machine Registry Commands ──

#[tauri::command]
pub async fn machines_list(state: State<'_, AppState>) -> Result<Vec<MachineInfo>, String> {
    log::info!("machines_list called");

    let registry = state
        .registry
        .lock()
        .map_err(|e| format!("Failed to acquire registry lock: {}", e))?;

    Ok(registry.list().into_iter().cloned().collect())
}

#[tauri::command]
pub async fn machine_add(state: State<'_, AppState>, info: MachineInfo) -> Result<String, String> {
    log::info!("machine_add called, name={}", info.name);

    let mut registry = state
        .registry
        .lock()
        .map_err(|e| format!("Failed to acquire registry lock: {}", e))?;

    let id = registry.register(info);
    let _ = registry.save();
    Ok(id)
}

#[tauri::command]
pub async fn machine_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    log::info!("machine_remove called, id={}", id);

    let mut registry = state
        .registry
        .lock()
        .map_err(|e| format!("Failed to acquire registry lock: {}", e))?;

    registry
        .unregister(&id)
        .map_err(|e| format!("Failed to remove machine: {}", e))?;
    let _ = registry.save();
    Ok(())
}

#[tauri::command]
pub async fn machine_update_status(
    state: State<'_, AppState>,
    id: String,
    status: String,
) -> Result<(), String> {
    log::info!("machine_update_status called, id={}, status={}", id, status);

    let machine_status = match status.as_str() {
        "online" => MachineStatus::Online,
        "busy" => MachineStatus::Busy,
        "offline" => MachineStatus::Offline,
        other => return Err(format!("Unknown status: {}", other)),
    };

    let mut registry = state
        .registry
        .lock()
        .map_err(|e| format!("Failed to acquire registry lock: {}", e))?;

    registry.update_status(&id, machine_status);
    Ok(())
}

// ── Discovery Commands ──

#[tauri::command]
pub async fn discover_gateways(
    state: State<'_, AppState>,
) -> Result<Vec<DiscoveredGateway>, String> {
    log::info!("discover_gateways called");

    use std::time::Duration;
    let mut rx = {
        let mut discovery = state
            .discovery
            .lock()
            .map_err(|e| format!("Failed to acquire discovery lock: {}", e))?;
        discovery
            .browse(Duration::from_secs(5))
            .map_err(|e| format!("Discovery error: {}", e))?
    };

    let mut gateways = Vec::new();
    while let Some(gw) = rx.recv().await {
        gateways.push(gw);
    }

    log::info!("discover_gateways found {} gateway(s)", gateways.len());
    Ok(gateways)
}

// ── SSH Tunnel Commands ──

#[tauri::command]
pub async fn ssh_connect(state: State<'_, AppState>, config: SshConfig) -> Result<String, String> {
    log::info!("ssh_connect called, host={}:{}", config.host, config.port);

    let mut ssh_opt = state
        .ssh
        .lock()
        .map_err(|e| format!("Failed to acquire SSH lock: {}", e))?;

    if ssh_opt.is_some() {
        return Err("SSH tunnel already active. Disconnect first.".to_string());
    }

    let host = config.host.clone();
    let mut tunnel = SshTunnel::new(config, DEFAULT_GATEWAY_PORT, DEFAULT_GATEWAY_PORT);
    tunnel
        .connect()
        .map_err(|e| format!("SSH connect failed: {}", e))?;

    *ssh_opt = Some(tunnel);
    Ok(host)
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    log::info!("ssh_disconnect called");

    let mut ssh_opt = state
        .ssh
        .lock()
        .map_err(|e| format!("Failed to acquire SSH lock: {}", e))?;

    match ssh_opt.take() {
        Some(mut tunnel) => tunnel
            .disconnect()
            .map_err(|e| format!("SSH disconnect failed: {}", e)),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn ssh_execute(state: State<'_, AppState>, command: String) -> Result<String, String> {
    log::warn!("ssh_execute called: {}", command);

    // Take the session out of the tunnel while holding the lock, then drop the lock
    let session_opt: Option<ssh2::Session> = {
        let mut ssh_opt = state
            .ssh
            .lock()
            .map_err(|e| format!("Failed to acquire SSH lock: {}", e))?;

        let tunnel = ssh_opt
            .as_mut()
            .ok_or_else(|| "No active SSH tunnel".to_string())?;

        tunnel.session.take()
    };
    // Lock dropped here — safe to await

    let session_arc = std::sync::Arc::new(std::sync::Mutex::new(session_opt));
    let arc_for_task = session_arc.clone();
    let command_clone = command.clone();

    let result = tokio::task::spawn_blocking(move || {
        let session_opt = arc_for_task.lock().unwrap();
        let session = session_opt.as_ref().ok_or("SSH session lost")?;

        let mut channel = session
            .channel_session()
            .map_err(|e| format!("IO error: {}", e))?;

        channel
            .exec(&command_clone)
            .map_err(|e| format!("IO error: {}", e))?;

        let mut output = String::new();
        use std::io::Read;
        channel
            .read_to_string(&mut output)
            .map_err(|e| format!("IO error: {}", e))?;

        channel
            .wait_close()
            .map_err(|e| format!("IO error: {}", e))?;

        Ok(output)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    // Put the session back
    match std::sync::Arc::try_unwrap(session_arc) {
        Ok(mutex) => {
            let put_back = mutex.into_inner().ok().flatten();
            let mut ssh_opt = state
                .ssh
                .lock()
                .map_err(|e| format!("Failed to acquire SSH lock: {}", e))?;
            if let Some(tunnel) = ssh_opt.as_mut() {
                tunnel.session = put_back;
            }
        }
        Err(_) => {
            // Session ref leaked — drop it, tunnel will reconnect if needed
        }
    }

    result
}

// ── Hone path discovery ──

/// Return the auto-detected Hone project root (the folder containing
/// `dist/cli.js`). The frontend uses this to pass a valid path to
/// `gateway_start` instead of guessing.
#[tauri::command]
pub async fn get_hone_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let path = state
        .hone_path
        .lock()
        .map_err(|e| format!("Failed to acquire hone_path lock: {}", e))?;
    Ok(path.clone())
}

/// Allow the user to override the auto-detected Hone path. Validates that
/// the directory contains `dist/cli.js` before accepting.
#[tauri::command]
pub async fn set_hone_path(
    state: State<'_, AppState>,
    new_path: String,
) -> Result<(), String> {
    let p = std::path::Path::new(&new_path);
    if !p.exists() {
        return Err(format!("路径不存在: {}", new_path));
    }
    if !p.join("dist").join("cli.js").exists() {
        return Err(format!("路径无效: {}/dist/cli.js 不存在", new_path));
    }
    let mut path = state
        .hone_path
        .lock()
        .map_err(|e| format!("Failed to acquire hone_path lock: {}", e))?;
    *path = Some(new_path);
    Ok(())
}

// ── Local CLI instance discovery (auto-pairing on same machine) ──

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LocalCliInstance {
    pub pid: u32,
    pub cwd: String,
    pub machine_name: String,
    pub os: String,
    pub version: String,
    pub mode: String,
    pub started_at: String,
}

/// Scan ~/.hone/instances/*.json for marker files dropped by running `hone`
/// CLI processes on this machine. Filter out dead PIDs and clean their markers.
#[tauri::command]
pub async fn local_cli_instances_list() -> Result<Vec<LocalCliInstance>, String> {
    let home = dirs::home_dir().ok_or_else(|| "未找到 home 目录".to_string())?;
    let dir = home.join(".hone").join("instances");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut alive: Vec<LocalCliInstance> = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let pid = match parsed.get("pid").and_then(|v| v.as_u64()) {
            Some(p) => p as u32,
            None => continue,
        };
        if !is_process_alive(pid) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        alive.push(LocalCliInstance {
            pid,
            cwd: parsed.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            machine_name: parsed.get("machineName").and_then(|v| v.as_str()).unwrap_or("Local").to_string(),
            os: parsed.get("os").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            version: parsed.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            mode: parsed.get("mode").and_then(|v| v.as_str()).unwrap_or("interactive").to_string(),
            started_at: parsed.get("startedAt").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        });
    }
    // Newest first
    alive.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(alive)
}

#[cfg(windows)]
fn is_process_alive(pid: u32) -> bool {
    use std::process::Command;
    // tasklist returns INFO if found, else "No tasks are running which match..."
    let out = match Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
        .output() {
        Ok(o) => o,
        Err(_) => return false,
    };
    let txt = String::from_utf8_lossy(&out.stdout);
    // Output is empty or "INFO:" line when no match. A real row contains the pid.
    txt.contains(&format!("\"{}\"", pid))
}

#[cfg(not(windows))]
fn is_process_alive(pid: u32) -> bool {
    // `kill -0 <pid>` returns 0 if the process exists and we can signal it.
    use std::process::Command;
    match Command::new("kill").args(["-0", &pid.to_string()]).status() {
        Ok(s) => s.success(),
        Err(_) => false,
    }
}

// ── Local CLI pairing ──

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LocalPairInput {
    pub host: String,
    pub port: u16,
    pub code: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LocalPairResult {
    pub ok: bool,
    pub token: Option<String>,
    pub machine_name: Option<String>,
    pub machine_id: Option<String>,
    pub os: Option<String>,
    pub cwd: Option<String>,
    pub pid: Option<u32>,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Pair with a `hone pair`-running CLI on the local network.
/// POSTs {code, clientName} to http://host:port/pair and returns the CLI's
/// identity info on success.
#[tauri::command]
pub async fn pair_with_local_cli(input: LocalPairInput) -> Result<LocalPairResult, String> {
    if input.code.is_empty() {
        return Err("请输入配对码".to_string());
    }
    if input.host.is_empty() {
        return Err("请输入 CLI 主机地址".to_string());
    }

    let url = format!("http://{}:{}/pair", input.host.trim(), input.port);
    let client_name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Hone Desktop".to_string());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP 客户端错误: {}", e))?;

    let body = serde_json::json!({
        "code": input.code.trim(),
        "clientName": client_name,
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("连接失败: {} — 确认 CLI 已运行 `hone pair`，端口可达", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("响应解析失败: {} — 收到: {}", e, text.chars().take(120).collect::<String>()))?;

    if !status.is_success() {
        let err = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or(&text)
            .to_string();
        return Ok(LocalPairResult {
            ok: false,
            token: None, machine_name: None, machine_id: None,
            os: None, cwd: None, pid: None, version: None,
            error: Some(err),
        });
    }

    Ok(LocalPairResult {
        ok: parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        token: parsed.get("token").and_then(|v| v.as_str()).map(String::from),
        machine_name: parsed.get("machineName").and_then(|v| v.as_str()).map(String::from),
        machine_id: parsed.get("machineId").and_then(|v| v.as_str()).map(String::from),
        os: parsed.get("os").and_then(|v| v.as_str()).map(String::from),
        cwd: parsed.get("cwd").and_then(|v| v.as_str()).map(String::from),
        pid: parsed.get("pid").and_then(|v| v.as_u64()).map(|n| n as u32),
        version: parsed.get("version").and_then(|v| v.as_str()).map(String::from),
        error: None,
    })
}

// ── Provider connectivity test ──

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TestProviderInput {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

/// Hit the configured chat-completions endpoint with a trivial 1-token request
/// to verify the API key + base URL + model name all work together.
#[tauri::command]
pub async fn test_provider(input: TestProviderInput) -> Result<String, String> {
    if input.api_key.is_empty() {
        return Err("请先填写 API Key".to_string());
    }

    let base = if !input.base_url.is_empty() {
        input.base_url.clone()
    } else {
        match input.provider.as_str() {
            "openai" => "https://api.openai.com".to_string(),
            "deepseek" => "https://api.deepseek.com".to_string(),
            _ => return Err("Custom provider 必须填写 Base URL".to_string()),
        }
    };

    let default_model = match input.provider.as_str() {
        "openai" => "gpt-4o-mini",
        "deepseek" => "deepseek-chat",
        _ => "gpt-4o-mini",
    };
    let model = if input.model.is_empty() {
        default_model.to_string()
    } else {
        input.model.clone()
    };

    let endpoint = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .post(&endpoint)
        .bearer_auth(&input.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("连接失败: {}", e))?;

    let status = resp.status();
    if status.is_success() {
        Ok(format!("✓ 连接成功 (模型: {})", model))
    } else {
        let text = resp.text().await.unwrap_or_default();
        let snippet = text.chars().take(200).collect::<String>();
        Err(format!("HTTP {}: {}", status, snippet))
    }
}

// ── Settings Commands ──

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<GatewayConfig, String> {
    log::info!("get_config called");

    let gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;

    Ok(gw.config())
}

#[tauri::command]
pub async fn save_config(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    config: GatewayConfig,
    hone_path: String,
) -> Result<(), String> {
    log::info!("save_config called");

    let mut gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;

    let node_path = get_node_path(&app);
    gw.apply_config(&node_path, config, &hone_path)
        .map_err(|e| format!("Failed to save config: {}", e))
}

// ── Schedule Commands ──

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScheduleInfo {
    pub id: String,
    pub title: String,
    pub desc: String,
    pub trigger: String, // "cron" | "interval" | "once"
    pub cron: String,
    #[serde(rename = "triggerLabel")]
    pub trigger_label: String,
    #[serde(rename = "nextRun")]
    pub next_run: String,
    pub enabled: bool,
    #[serde(rename = "lastRun")]
    pub last_run: Option<String>,
    #[serde(rename = "lastStatus")]
    pub last_status: Option<String>, // "success" | "fail" | null
    pub delivery: String, // "desktop" | "cli" | "session"
}

fn schedules_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    data_dir.join("schedules.json")
}

#[tauri::command]
pub async fn schedules_list(app: tauri::AppHandle) -> Result<Vec<ScheduleInfo>, String> {
    let path = schedules_path(&app);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read schedules: {}", e))?;
    let schedules: Vec<ScheduleInfo> = serde_json::from_str(&data).unwrap_or_default();
    Ok(schedules)
}

#[tauri::command]
pub async fn schedules_save(
    app: tauri::AppHandle,
    schedules: Vec<ScheduleInfo>,
) -> Result<(), String> {
    let path = schedules_path(&app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&schedules)
        .map_err(|e| format!("Failed to serialize schedules: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write schedules: {}", e))
}

// ── Auto-start Commands ──

#[tauri::command]
pub async fn autostart_is_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    let autostart = app.autolaunch();
    autostart
        .is_enabled()
        .map_err(|e| format!("Failed to check autostart: {}", e))
}

#[tauri::command]
pub async fn autostart_toggle(app: tauri::AppHandle, enable: bool) -> Result<bool, String> {
    let autostart = app.autolaunch();
    if enable {
        autostart
            .enable()
            .map_err(|e| format!("Failed to enable autostart: {}", e))?;
    } else {
        autostart
            .disable()
            .map_err(|e| format!("Failed to disable autostart: {}", e))?;
    }
    autostart
        .is_enabled()
        .map_err(|e| format!("Failed to verify autostart: {}", e))
}

// ── Canvas session listing ──

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CanvasSessionInfo {
    pub id: String,
    pub name: String,
    pub modified_at: String,
}

/// List subfolders of ~/.hone/canvas/ — each one is a canvas session.
#[tauri::command]
pub async fn canvas_sessions_list() -> Result<Vec<CanvasSessionInfo>, String> {
    let home = dirs::home_dir().ok_or_else(|| "未找到 home 目录".to_string())?;
    let canvas_dir = home.join(".hone").join("canvas");
    if !canvas_dir.exists() {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    let entries = std::fs::read_dir(&canvas_dir)
        .map_err(|e| format!("读取 canvas 目录失败: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("(unknown)")
            .to_string();
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| {
                chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        sessions.push(CanvasSessionInfo {
            id: name.clone(),
            name,
            modified_at: modified,
        });
    }
    // Newest first
    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(sessions)
}

// ── CLI Task Workspace Commands ──
//
// Lets the desktop spawn one-shot CLI tasks in arbitrary working directories
// and stream their stdout/stderr back via Tauri events. Powers the multi-project
// "workspace" view where the user can dispatch tasks to several projects in
// parallel from a single window.

#[tauri::command]
pub async fn cli_task_run(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    task: String,
) -> Result<String, String> {
    use tauri::Emitter;
    use tokio::io::{AsyncBufReadExt, BufReader};

    log::info!("cli_task_run cwd={} task_len={}", cwd, task.len());

    // Resolve hone CLI path
    let hone_path = {
        let p = state.hone_path.lock().map_err(|e| format!("lock: {}", e))?;
        p.clone()
    }
    .ok_or_else(|| "Hone path not configured".to_string())?;

    let cli_js = std::path::Path::new(&hone_path).join("dist").join("cli.js");
    if !cli_js.exists() {
        return Err(format!("CLI not found at {}", cli_js.display()));
    }

    // Validate cwd
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.exists() || !cwd_path.is_dir() {
        return Err(format!("Working directory does not exist: {}", cwd));
    }

    let task_id = uuid::Uuid::new_v4().to_string();
    let event_chunk = format!("cli_task_chunk_{}", task_id);
    let event_done = format!("cli_task_done_{}", task_id);

    let app_handle = app.clone();
    let task_id_for_spawn = task_id.clone();
    let task_for_spawn = task.clone();
    let cwd_for_spawn = cwd.clone();

    let node_path = get_node_path(&app);
    let node_path_for_spawn = node_path.clone();

    // Spawn in a tokio task so cli_task_run returns immediately
    tokio::spawn(async move {
        let mut cmd = tokio::process::Command::new(&node_path_for_spawn);
        cmd.arg(&cli_js)
            .arg("-p")
            .arg(&task_for_spawn)
            .current_dir(&cwd_for_spawn)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null());

        // On Windows hide console window for the child node process
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app_handle.emit(&event_done, serde_json::json!({
                    "task_id": task_id_for_spawn,
                    "status": "error",
                    "error": format!("spawn failed: {}", e),
                }));
                return;
            }
        };

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let emit_stdout = {
            let app_handle = app_handle.clone();
            let event = event_chunk.clone();
            let task_id = task_id_for_spawn.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = app_handle.emit(&event, serde_json::json!({
                        "task_id": task_id, "stream": "stdout", "line": line,
                    }));
                }
            })
        };
        let emit_stderr = {
            let app_handle = app_handle.clone();
            let event = event_chunk.clone();
            let task_id = task_id_for_spawn.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = app_handle.emit(&event, serde_json::json!({
                        "task_id": task_id, "stream": "stderr", "line": line,
                    }));
                }
            })
        };

        let status = child.wait().await;
        let _ = emit_stdout.await;
        let _ = emit_stderr.await;

        let (ok, code) = match status {
            Ok(s) => (s.success(), s.code().unwrap_or(-1)),
            Err(_) => (false, -1),
        };
        let _ = app_handle.emit(&event_done, serde_json::json!({
            "task_id": task_id_for_spawn,
            "status": if ok { "ok" } else { "fail" },
            "exit_code": code,
        }));
    });

    Ok(task_id)
}

// ── PTY Commands ──
//
// Real interactive terminal for the multi-CLI workspace. Each session runs
// `node <hone>/dist/cli.js` in a pty so Ink TUIs render correctly. Output
// streams over Tauri event `pty_data_<session_id>`; input via `pty_write`.

#[tauri::command]
pub async fn pty_open(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    log::info!("pty_open id={} cwd={}", session_id, cwd);

    let hone_path = {
        let p = state.hone_path.lock().map_err(|e| format!("lock: {}", e))?;
        p.clone()
    }
    .ok_or_else(|| "Hone path not configured".to_string())?;

    let cli_js = std::path::Path::new(&hone_path).join("dist").join("cli.js");
    if !cli_js.exists() {
        return Err(format!("CLI not found at {}", cli_js.display()));
    }

    let node_path = get_node_path(&app);
    let args = vec![cli_js.to_string_lossy().to_string()];
    let env = vec![
        ("FORCE_COLOR".to_string(), "1".to_string()),
        ("TERM".to_string(), "xterm-256color".to_string()),
    ];

    state.pty.open(app, session_id, &node_path, args, Some(&cwd), cols, rows, env)
}

#[tauri::command]
pub async fn pty_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.pty.write(&session_id, &data)
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty.resize(&session_id, cols, rows)
}

#[tauri::command]
pub async fn pty_close(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.pty.close(&session_id)
}

// ── Execution Log Commands ──

#[tauri::command]
pub async fn execution_log_list(
    app: tauri::AppHandle,
) -> Result<Vec<crate::scheduler::ExecutionLog>, String> {
    let path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("execution_log.json");

    if !path.exists() {
        return Ok(Vec::new());
    }

    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read execution log: {}", e))?;
    let logs: Vec<crate::scheduler::ExecutionLog> = serde_json::from_str(&data).unwrap_or_default();
    Ok(logs)
}
