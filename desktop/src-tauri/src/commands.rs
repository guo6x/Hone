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
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use std::path::PathBuf;
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&data_dir);

    // Try to guess the hone project root from the executable location
    let hone_path = guess_hone_path(app);

    app.manage(AppState {
        gateway: Mutex::new(GatewayManager::new()),
        registry: Mutex::new(MachineRegistry::new(data_dir.join("machines.json"))),
        discovery: Mutex::new(MdnsDiscovery::new()),
        ssh: Mutex::new(None),
        hone_path: Mutex::new(hone_path.clone()),
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
    // Try common locations relative to the executable
    let exe_dir = app.path().resource_dir().ok()?;

    // Check if hone CLI exists at ../hone relative to the Tauri app
    let candidate = exe_dir.parent()?.parent()?.parent()?.join("hone");

    if candidate.join("dist").join("cli.js").exists() {
        return Some(candidate.to_string_lossy().to_string());
    }

    // Fallback: use the app data directory + "hone"
    let data_dir = app.path().app_data_dir().ok()?;
    let fallback = data_dir.parent()?.parent()?.parent()?.join("hone");
    if fallback.join("dist").join("cli.js").exists() {
        return Some(fallback.to_string_lossy().to_string());
    }

    // No auto-discovery — frontend will provide path via gateway_start
    None
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

    let url = relay_url.unwrap_or_else(|| "wss://hone-relay.marsailleippi79.workers.dev".into());

    gw.start(&hone_path, &url)
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
    config: GatewayConfig,
    hone_path: String,
) -> Result<(), String> {
    log::info!("save_config called");

    let mut gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;

    gw.apply_config(config, &hone_path)
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
