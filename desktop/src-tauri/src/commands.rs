use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

use crate::gateway_manager::{GatewayConfig, GatewayConnectionInfo, GatewayManager, GatewayStatus};
use crate::machine_registry::{MachineInfo, MachineRegistry, MachineStatus};
use crate::mdns_discovery::{DiscoveredGateway, MdnsDiscovery};
use crate::secret_store;
use crate::ssh_tunnel::{SshConfig, SshTunnel, DEFAULT_GATEWAY_PORT};
use tauri_plugin_autostart::ManagerExt;

pub struct AppState {
    pub gateway: Mutex<GatewayManager>,
    pub registry: Mutex<MachineRegistry>,
    pub discovery: Mutex<MdnsDiscovery>,
    pub ssh: Mutex<Option<SshTunnel>>,
    pub hone_path: Mutex<Option<String>>,
    pub pty: crate::pty_manager::PtyManager,
    /// 限制 cli_task_run 的最大并发数（最多 5 个并行 CLI 任务），防止资源耗尽。
    /// 使用 acquire_owned 获取OwnedSemaphorePermit，随 tokio::spawn 的任务结束自动 drop 释放。
    pub cli_task_semaphore: Arc<tokio::sync::Semaphore>,
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
    migrate_schedule_store(&data_dir);

    // Try to guess the hone project root from the executable location
    let hone_path = guess_hone_path(app);

    // Bind the gateway config to disk so user settings (API key, model, etc.)
    // survive app restarts. Without this every relaunch loses everything.
    let mut gateway = GatewayManager::new();
    gateway.bind_config_file(data_dir.join("gateway-config.json"));

    // Set data_dir on config before starting (gateway_start command does the same)
    {
        let mut cfg = gateway.config();
        cfg.data_dir = Some(data_dir.to_string_lossy().to_string());
        gateway.set_config(cfg);
    }

    // Auto-start the gateway daemon immediately at app launch if configured.
    // This bypasses the frontend IPC round-trip (useHonePath → useEffect →
    // ipcGatewayStart) which adds 2-5 seconds of latency and can silently fail
    // if the IPC chain has any timing issue. Starting here means the daemon
    // is already spawning by the time the frontend even loads.
    let node_path = get_node_path(app.handle());
    if let Some(ref path) = hone_path {
        let cfg = gateway.config();
        if cfg.auto_start {
            let relay = cfg.relay_url.clone();
            log::info!("Auto-starting gateway daemon at app launch (hone_path={}, relay={})", path, relay);
            if let Err(e) = gateway.start(&node_path, path, &relay) {
                log::warn!("Auto-start gateway failed: {}", e);
            }
        }
    }

    app.manage(AppState {
        gateway: Mutex::new(gateway),
        registry: Mutex::new(MachineRegistry::new(data_dir.join("machines.json"))),
        discovery: Mutex::new(MdnsDiscovery::new()),
        ssh: Mutex::new(None),
        hone_path: Mutex::new(hone_path.clone()),
        pty: crate::pty_manager::PtyManager::new(),
        cli_task_semaphore: Arc::new(tokio::sync::Semaphore::new(5)),
    });

    Ok(())
}

/// Attempt to locate the hone project root directory.
fn guess_hone_path(app: &tauri::App) -> Option<String> {
    // 1. Try relative to current executable — check both direct and resources/ subdirectory
    //    NSIS 安装布局: C:\Program Files\Hone\hone-desktop.exe + resources\dist\cli.js
    //    dev 布局: target/release/hone-desktop.exe + 向上找到仓库根 dist/cli.js
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            // 先检查 exe 同级的 resources/ 子目录（NSIS 安装后的标准布局）
            let res_dir = exe_dir.join("resources");
            if res_dir.join("dist").join("cli.js").exists() {
                log::info!("Detected Hone path from exe_dir/resources: {}", res_dir.display());
                return Some(res_dir.to_string_lossy().to_string());
            }
            // 再检查 exe 同级目录（某些打包方式将 resources 平铺）
            if exe_dir.join("dist").join("cli.js").exists() {
                log::info!("Detected Hone path from exe_dir: {}", exe_dir.display());
                return Some(exe_dir.to_string_lossy().to_string());
            }
        }
        // 向上遍历 5 级查找仓库根目录（dev 环境下从 target/release 向上找到源码根）
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

    // 3. Try relative to resource_dir (Tauri API, may return Err in some contexts)
    match app.path().resource_dir() {
        Ok(res_dir) => {
            if res_dir.join("dist").join("cli.js").exists() {
                log::info!("Detected Hone path from resource_dir: {}", res_dir.display());
                return Some(res_dir.to_string_lossy().to_string());
            }
            let res_sub = res_dir.join("resources");
            if res_sub.join("dist").join("cli.js").exists() {
                log::info!("Detected Hone path from resource_dir/resources: {}", res_sub.display());
                return Some(res_sub.to_string_lossy().to_string());
            }
            log::warn!("resource_dir returned {} but dist/cli.js not found there", res_dir.display());
        }
        Err(e) => {
            log::error!("resource_dir() failed: {}", e);
        }
    }

    log::error!("Could not detect Hone path from exe, cwd, or resource_dir");
    None
}

/// Resolve the correct Node.js binary path.
/// If a bundled Node.js is present under resource_dir, we prefer it;
/// otherwise we fallback to the system 'node'.
fn get_node_path(app: &tauri::AppHandle) -> String {
    // 0. 直接从 current_exe() 查找 bundled node — 最可靠的方式，不依赖 resource_dir()
    //    NSIS 安装布局: C:\Program Files\Hone\resources\node\node.exe
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidates = [
                exe_dir.join("resources").join("node").join("node.exe"),
                exe_dir.join("node").join("node.exe"),
            ];
            for p in &candidates {
                if p.exists() {
                    log::info!("Using bundled Node from exe_dir: {}", p.display());
                    return p.to_string_lossy().to_string();
                }
            }
        }
    }

    // 1. Bundled node shipped alongside the app resources (Tauri resource_dir API).
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

    // 2. Probe well-known install locations. The desktop app is launched by
    //    double-clicking the exe, so it inherits the *system* PATH — which on
    //    many Windows machines does NOT include Node (Node is only on the
    //    user's shell PATH via nvm / TRAE / VS Code's integrated terminal).
    //    Without this probe, `Command::new("node")` fails with "file not
    //    found" and the gateway can never start.
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("AppData").join("Roaming").join("nvm").join("current").join("node.exe"));
        candidates.push(home.join("AppData").join("Roaming").join("npm").join("node.exe"));
        candidates.push(home.join(".node").join("node.exe"));
        candidates.push(home.join("Documents").join("node").join("node.exe"));
        candidates.push(home.join("node").join("node.exe"));
    }
    // Documents folder may live on a different drive (e.g. D:\) than USERPROFILE.
    // It may also be redirected to a subdirectory (e.g. ...\Documents\EasyShare),
    // so we probe both the reported path and its parent.
    if let Some(docs) = dirs::document_dir() {
        candidates.push(docs.join("node").join("node.exe"));
        if let Some(parent) = docs.parent() {
            candidates.push(parent.join("node").join("node.exe"));
        }
    }
    candidates.push(std::path::PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
    candidates.push(std::path::PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"));
    for p in &candidates {
        if p.exists() {
            log::info!("Using Node from known location: {}", p.display());
            return p.to_string_lossy().to_string();
        }
    }
    // nvm: pick the first version dir under AppData\Roaming\nvm
    if let Some(home) = dirs::home_dir() {
        let nvm_dir = home.join("AppData").join("Roaming").join("nvm");
        if nvm_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                for entry in entries.flatten() {
                    let node_exe = entry.path().join("node.exe");
                    if node_exe.exists() {
                        log::info!("Using Node from nvm: {}", node_exe.display());
                        return node_exe.to_string_lossy().to_string();
                    }
                }
            }
        }
    }

    // 3. Last resort: rely on PATH lookup (may still work when launched from
    //    a terminal that injected Node into PATH).
    log::warn!("No bundled or known Node install found — falling back to PATH 'node'. If gateway fails to start, install Node.js or add it to PATH.");
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
    // start() internally calls std::thread::sleep while waiting for the daemon
    // process to initialize. Use block_in_place to avoid blocking the tokio
    // worker thread — other async tasks can continue running on this runtime.
    let start_result = tokio::task::block_in_place(|| {
        gw.start(&node_path, &hone_path, &url)
    });
    match start_result {
        Ok(()) => Ok(format!("Gateway started: {}", url)),
        // AlreadyRunning is not an error — Rust setup() may have auto-started
        // the daemon before the frontend IPC call arrives. Returning Ok avoids
        // a spurious error message in the UI.
        Err(crate::gateway_manager::GatewayError::AlreadyRunning) => {
            Ok("Gateway already running".to_string())
        }
        Err(e) => Err(format!("Failed to start gateway: {}", e)),
    }
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
    // Reap a crashed daemon before reporting status, otherwise the frontend
    // sees "Running" forever for a dead process and never recovers.
    let mut gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;
    gw.check_alive();
    Ok(gw.status().clone())
}

#[tauri::command]
pub async fn gateway_uptime(state: State<'_, AppState>) -> Result<Option<u64>, String> {
    let mut gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;
    gw.check_alive();
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
    let _ = registry.save();
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
    // mDNS discovery channel should close after the browse duration, but add
    // a hard timeout to prevent indefinite hangs if the channel never closes.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(gw)) => gateways.push(gw),
            Ok(None) => break,       // channel closed
            Err(_) => break,         // timeout reached
        }
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

/// 检测破坏性命令，防止误操作或恶意前端代码执行。
/// 返回 true 表示该命令应被拒绝。
fn is_dangerous_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    lower.contains("rm -rf /")
        || lower.contains("mkfs")
        || lower.contains("shutdown")
        || lower.contains("reboot")
        || lower.contains(":(){:|:&};:")
        || lower.contains("dd if=")
        || lower.contains("> /dev/sda")
        || lower.contains("chmod -R 777 /")
}

#[tauri::command]
pub async fn ssh_execute(state: State<'_, AppState>, command: String) -> Result<String, String> {
    log::warn!("ssh_execute called: {}", command);

    // 基本危险命令检测 — 防止误操作或恶意前端代码执行破坏性命令
    if is_dangerous_command(&command) {
        return Err("危险命令已被拒绝执行。如确需执行，请手动在 SSH 终端中操作。".to_string());
    }

    // Clone the Arc to the shared session while holding the tunnel lock, then
    // release the lock immediately. The session stays inside the tunnel, so a
    // concurrent ssh_execute call will also find it present — eliminating the
    // previous race where the second caller saw `session = None`.
    let session_arc: Option<std::sync::Arc<std::sync::Mutex<ssh2::Session>>> = {
        let ssh_opt = state
            .ssh
            .lock()
            .map_err(|e| format!("Failed to acquire SSH lock: {}", e))?;
        let tunnel = ssh_opt
            .as_ref()
            .ok_or_else(|| "No active SSH tunnel".to_string())?;
        tunnel.session.clone()
    };
    // Lock dropped here — safe to await

    let session_arc = session_arc.ok_or_else(|| "No active SSH session".to_string())?;

    // Run the blocking SSH I/O on a spawn_blocking thread. The Arc is moved
    // in; the mutex serializes concurrent commands safely.
    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let session = session_arc
            .lock()
            .map_err(|e| format!("Failed to acquire session lock: {}", e))?;

        let mut channel = session
            .channel_session()
            .map_err(|e| format!("IO error: {}", e))?;

        channel
            .exec(&command)
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
/// the directory contains `dist/cli.js` and stops a running Gateway so it
/// can be restarted with the new bundled CLI path.
#[tauri::command]
pub async fn set_hone_path(
    _app_handle: tauri::AppHandle,
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
    {
        let mut path = state
            .hone_path
            .lock()
            .map_err(|e| format!("Failed to acquire hone_path lock: {}", e))?;
        *path = Some(new_path.clone());
    }

    // If the Gateway daemon is currently running, stop it — the user will
    // need to restart it from the UI so it picks up the new path. We don't
    // auto-restart here because gateway_start needs relay_url and other
    // config that's currently only known to the frontend.
    {
        let mut gw = state
            .gateway
            .lock()
            .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;
        if matches!(gw.status(), GatewayStatus::Running | GatewayStatus::Starting) {
            if let Err(e) = gw.stop() {
                log::warn!("Failed to stop gateway after hone path change: {}", e);
            }
        }
    }

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
/// 用 spawn_blocking 包裹避免阻塞 tokio 异步运行时；用单次 tasklist 批量获取存活 PID。
#[tauri::command]
pub async fn local_cli_instances_list() -> Result<Vec<LocalCliInstance>, String> {
    tokio::task::spawn_blocking(|| {
        let home = dirs::home_dir().ok_or_else(|| "未找到 home 目录".to_string())?;
        let dir = home.join(".hone").join("instances");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        // 批量获取所有存活 PID 及其父进程 PID，避免逐个 spawn tasklist
        let pid_parents = get_alive_pid_parents();
        let current_pid = std::process::id();
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
            let mode = parsed.get("mode").and_then(|v| v.as_str()).unwrap_or("interactive").to_string();
            let ppid = pid_parents.get(&pid).copied();
            if !pid_parents.contains_key(&pid) {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            // Gateway 子进程是后台启动的；如果父进程（桌面端）已不存在，说明是孤儿进程，应该清理
            // 注意：ppid=0 表示 tasklist fallback 无法获取父进程，跳过孤儿检测避免误杀
            if mode == "gateway" {
                if let Some(ppid) = ppid {
                    if ppid == 0 {
                        // ppid 未知，跳过孤儿检测
                    } else if ppid != current_pid && !pid_parents.contains_key(&ppid) {
                        log::info!("Cleaning orphan gateway process pid={} ppid={}", pid, ppid);
                        #[cfg(windows)]
                        {
                            use std::os::windows::process::CommandExt;
                            let _ = std::process::Command::new("taskkill")
                                .args(["/T", "/F", "/PID", &pid.to_string()])
                                .creation_flags(0x08000000)
                                .output();
                        }
                        #[cfg(not(windows))]
                        {
                            let _ = std::process::Command::new("kill")
                                .args(["-9", &pid.to_string()])
                                .output();
                        }
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                }
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
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))?
}

/// 批量获取所有存活进程 PID 及其父进程 PID。
/// Windows 优先用 PowerShell Get-CimInstance（wmic 在 Win11 已弃用），
/// fallback 到 tasklist（仅返回 PID，无 ppid）。
#[cfg(windows)]
fn get_alive_pid_parents() -> std::collections::HashMap<u32, u32> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    let mut map = std::collections::HashMap::new();

    // 方案1: PowerShell Get-CimInstance（返回 PID 和 ParentProcessId）
    let ps_out = Command::new("powershell")
        .args([
            "-NoProfile", "-NonInteractive", "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation",
        ])
        .creation_flags(0x08000000)
        .output();
    if let Ok(out) = ps_out {
        let txt = String::from_utf8_lossy(&out.stdout);
        // CSV 格式: "ProcessId","ParentProcessId"
        let lines: Vec<&str> = txt.lines().collect();
        if lines.len() >= 2 {
            // 找到列索引
            let header: Vec<&str> = lines[0].split(',').map(|s| s.trim().trim_matches('"')).collect();
            let pid_idx = header.iter().position(|h| h.eq_ignore_ascii_case("ProcessId"));
            let ppid_idx = header.iter().position(|h| h.eq_ignore_ascii_case("ParentProcessId"));
            if let (Some(pi), Some(ppi)) = (pid_idx, ppid_idx) {
                for line in &lines[1..] {
                    let parts: Vec<&str> = line.split(',').map(|s| s.trim().trim_matches('"')).collect();
                    if parts.len() > pi.max(ppi) {
                        if let (Ok(pid), Ok(ppid)) = (
                            parts[pi].parse::<u32>(),
                            parts[ppi].parse::<u32>(),
                        ) {
                            map.insert(pid, ppid);
                        }
                    }
                }
            }
        }
        if !map.is_empty() {
            return map;
        }
    }

    // 方案2: tasklist（仅返回 PID，无 ppid；用于无法运行 PowerShell 的场景）
    if let Ok(out) = Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .creation_flags(0x08000000)
        .output()
    {
        let txt = String::from_utf8_lossy(&out.stdout);
        // CSV 每行: "Image Name","PID","Session Name","Session#","Mem Usage"
        for line in txt.lines() {
            let parts: Vec<&str> = line.split(',').map(|s| s.trim().trim_matches('"')).collect();
            if parts.len() >= 2 {
                if let Ok(pid) = parts[1].parse::<u32>() {
                    map.insert(pid, 0); // ppid 未知，填 0
                }
            }
        }
    }
    map
}

#[cfg(not(windows))]
fn get_alive_pid_parents() -> std::collections::HashMap<u32, u32> {
    use std::process::Command;
    let mut map = std::collections::HashMap::new();
    if let Ok(out) = Command::new("ps").args(["-eo", "pid,ppid"]).output() {
        let txt = String::from_utf8_lossy(&out.stdout);
        for line in txt.lines().skip(1) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                if let (Ok(pid), Ok(ppid)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                    map.insert(pid, ppid);
                }
            }
        }
    }
    map
}

// ── Local CLI pairing ──

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LocalPairInput {
    #[serde(default)]
    pub host: String,
    pub port: u16,
    #[serde(default)]
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
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
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

// ── Provider model list fetch ──

#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
}

/// Fetch available models from an OpenAI-compatible /models endpoint.
#[tauri::command]
pub async fn provider_fetch_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<ModelInfo>, String> {
    if base_url.trim().is_empty() {
        return Err("Base URL 不能为空".to_string());
    }
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端错误: {}", e))?;

    let resp = client
        .get(&url)
        .bearer_auth(&api_key)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text.chars().take(200).collect::<String>()));
    }

    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析失败: {} — 响应: {}", e, text.chars().take(200).collect::<String>()))?;

    let data = parsed.get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("响应缺少 data 数组: {}", text.chars().take(200).collect::<String>()))?;

    let models: Vec<ModelInfo> = data.iter().filter_map(|item| {
        let id = item.get("id")?.as_str()?.to_string();
        let owned_by = item.get("owned_by").and_then(|v| v.as_str()).map(String::from);
        Some(ModelInfo { id, owned_by })
    }).collect();

    Ok(models)
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
pub async fn gateway_connection_info(
    state: State<'_, AppState>,
) -> Result<GatewayConnectionInfo, String> {
    let gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;
    Ok(gw.connection_info())
}

#[tauri::command]
pub async fn mobile_pairing_rotate(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<GatewayConnectionInfo, String> {
    let hone_path = state
        .hone_path
        .lock()
        .map_err(|e| format!("Failed to acquire hone_path lock: {}", e))?
        .clone()
        .ok_or_else(|| "Hone path is not configured".to_string())?;
    let node_path = get_node_path(&app);
    let mut gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;
    gw.rotate_pairing_challenge(&node_path, &hone_path)
        .map_err(|e| format!("Failed to rotate mobile pairing: {}", e))
}

#[tauri::command]
pub async fn save_config(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    config: GatewayConfig,
    hone_path: String,
) -> Result<(), String> {
    log::info!("save_config called");

    // A Gateway workspace is not the Hone CLI bundle location. Only replace
    // the bundle path when the caller supplied a directory that actually
    // contains dist/cli.js; otherwise preserve the packaged/discovered path.
    if !hone_path.trim().is_empty()
        && std::path::Path::new(&hone_path)
            .join("dist")
            .join("cli.js")
            .exists()
    {
        let mut path = state
            .hone_path
            .lock()
            .map_err(|e| format!("Failed to acquire hone_path lock: {}", e))?;
        *path = Some(hone_path.clone());
    }

    let mut gw = state
        .gateway
        .lock()
        .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;

    let node_path = get_node_path(&app);
    let effective_hone_path = state
        .hone_path
        .lock()
        .map_err(|e| format!("Failed to acquire hone_path lock: {}", e))?
        .clone()
        .unwrap_or(hone_path);
    gw.apply_config(&node_path, config, &effective_hone_path)
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

/// On-disk schedule schema consumed by the Node Gateway scheduler. The
/// desktop UI uses `ScheduleInfo`; conversion happens at the IPC boundary so
/// there is only one durable source of truth and one executor.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct GatewayScheduleTrigger {
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cron: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    at: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct GatewayScheduleFileEntry {
    id: String,
    text: String,
    trigger: GatewayScheduleTrigger,
    task: String,
    delivery: String,
    enabled: bool,
    #[serde(rename = "createdAt")]
    created_at: i64,
    #[serde(default, rename = "lastTriggeredAt")]
    last_triggered_at: Option<i64>,
    #[serde(default, rename = "lastStatus")]
    last_status: Option<String>,
}

fn schedules_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    data_dir.join("schedules.json")
}

fn write_gateway_schedules(
    path: &std::path::Path,
    schedules: &[GatewayScheduleFileEntry],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(schedules)
        .map_err(|e| format!("Failed to serialize schedules: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("Failed to write schedules: {e}"))?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        // Windows cannot always rename over an existing file. Retrying after
        // deletion keeps save behavior consistent with the gateway's Node
        // atomic writer while still leaving the temporary file on first error.
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| format!("Failed to replace schedules: {e}"))?;
            std::fs::rename(&tmp, path).map_err(|e| format!("Failed to finalize schedules: {e}"))?;
        } else {
            return Err(format!("Failed to rename schedules: {error}"));
        }
    }
    Ok(())
}

fn read_gateway_schedules(path: &std::path::Path) -> Result<Vec<GatewayScheduleFileEntry>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(path).map_err(|e| format!("Failed to read schedules: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Invalid gateway schedule store: {e}"))
}

fn gateway_schedule_to_ui(entry: GatewayScheduleFileEntry) -> ScheduleInfo {
    let (trigger, cron) = match entry.trigger.kind.as_str() {
        "interval" => (
            "interval".to_string(),
            entry.trigger.ms.map(|value| (value / 60_000).max(1).to_string()).unwrap_or_else(|| "60".to_string()),
        ),
        "one-time" => (
            "once".to_string(),
            entry.trigger.at.and_then(chrono::DateTime::from_timestamp_millis)
                .map(|value| value.with_timezone(&chrono::Local).format("%Y-%m-%dT%H:%M").to_string())
                .unwrap_or_default(),
        ),
        _ => ("cron".to_string(), entry.trigger.cron.unwrap_or_default()),
    };
    let last_status = entry.last_status.map(|status| if status == "ok" { "success".to_string() } else { status });
    ScheduleInfo {
        id: entry.id,
        title: entry.text.clone(),
        desc: if entry.task.is_empty() { entry.text } else { entry.task },
        trigger_label: cron.clone(),
        next_run: "-".to_string(),
        trigger,
        cron,
        enabled: entry.enabled,
        last_run: entry.last_triggered_at
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|value| value.to_rfc3339()),
        last_status,
        delivery: match entry.delivery.as_str() {
            "execute" => "cli".to_string(),
            "notify" => "desktop".to_string(),
            _ => "session".to_string(),
        },
    }
}

fn ui_schedule_to_gateway(
    schedule: &ScheduleInfo,
    existing: Option<&GatewayScheduleFileEntry>,
) -> Result<GatewayScheduleFileEntry, String> {
    let trigger = match schedule.trigger.as_str() {
        "cron" => {
            let cron = schedule.cron.trim();
            if cron.split_whitespace().count() != 5 {
                return Err(format!("Invalid cron for schedule {}", schedule.id));
            }
            GatewayScheduleTrigger { kind: "cron".to_string(), cron: Some(cron.to_string()), ms: None, at: None }
        }
        "interval" => {
            let minutes = schedule.cron.trim().parse::<u64>()
                .ok().filter(|value| *value > 0)
                .ok_or_else(|| format!("Invalid interval for schedule {}", schedule.id))?;
            GatewayScheduleTrigger { kind: "interval".to_string(), cron: None, ms: Some(minutes * 60_000), at: None }
        }
        "once" => {
            let local = chrono::NaiveDateTime::parse_from_str(schedule.cron.trim(), "%Y-%m-%dT%H:%M")
                .map_err(|_| format!("Invalid one-time schedule for {}", schedule.id))?;
            let at = chrono::TimeZone::from_local_datetime(&chrono::Local, &local)
                .single()
                .ok_or_else(|| format!("Ambiguous local time for schedule {}", schedule.id))?
                .timestamp_millis();
            GatewayScheduleTrigger { kind: "one-time".to_string(), cron: None, ms: None, at: Some(at) }
        }
        _ => return Err(format!("Unknown trigger for schedule {}", schedule.id)),
    };
    let delivery = match schedule.delivery.as_str() {
        "desktop" => "notify",
        "cli" => "execute",
        _ => "both",
    }.to_string();
    Ok(GatewayScheduleFileEntry {
        id: schedule.id.clone(),
        text: if schedule.title.trim().is_empty() { schedule.desc.clone() } else { schedule.title.clone() },
        trigger,
        task: schedule.desc.clone(),
        delivery,
        enabled: schedule.enabled,
        created_at: existing.map(|entry| entry.created_at).unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
        last_triggered_at: existing.and_then(|entry| entry.last_triggered_at),
        last_status: existing.and_then(|entry| entry.last_status.clone()),
    })
}

/// Migrate the desktop scheduler's historic UI-shaped JSON before the Gateway
/// starts. This prevents an old string `trigger` from being interpreted as an
/// immediate one-time Gateway schedule.
fn migrate_schedule_store(data_dir: &std::path::Path) {
    let path = data_dir.join("schedules.json");
    if !path.exists() || read_gateway_schedules(&path).is_ok() {
        return;
    }
    let Ok(data) = std::fs::read_to_string(&path) else { return; };
    let Ok(legacy) = serde_json::from_str::<Vec<ScheduleInfo>>(&data) else {
        log::warn!("Could not migrate unrecognized schedule store {}", path.display());
        return;
    };
    let migrated: Result<Vec<_>, _> = legacy.iter().map(|entry| ui_schedule_to_gateway(entry, None)).collect();
    match migrated.and_then(|entries| write_gateway_schedules(&path, &entries)) {
        Ok(()) => log::info!("Migrated {} desktop schedules to Gateway schema", legacy.len()),
        Err(error) => log::warn!("Could not migrate schedule store: {}", error),
    }
}

#[tauri::command]
pub async fn schedules_list(app: tauri::AppHandle) -> Result<Vec<ScheduleInfo>, String> {
    let path = schedules_path(&app);
    migrate_schedule_store(path.parent().unwrap_or(std::path::Path::new(".")));
    read_gateway_schedules(&path).map(|entries| entries.into_iter().map(gateway_schedule_to_ui).collect())
}

#[tauri::command]
pub async fn schedules_save(
    app: tauri::AppHandle,
    schedules: Vec<ScheduleInfo>,
) -> Result<(), String> {
    let path = schedules_path(&app);
    migrate_schedule_store(path.parent().unwrap_or(std::path::Path::new(".")));
    let existing = read_gateway_schedules(&path)?;
    let existing_by_id: std::collections::HashMap<_, _> = existing
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    let gateway_entries: Result<Vec<_>, _> = schedules
        .iter()
        .map(|schedule| ui_schedule_to_gateway(schedule, existing_by_id.get(schedule.id.as_str()).copied()))
        .collect();
    write_gateway_schedules(&path, &gateway_entries?)
}

#[cfg(test)]
mod schedule_store_tests {
    use super::*;

    fn legacy_schedule(id: &str) -> ScheduleInfo {
        ScheduleInfo {
            id: id.to_string(),
            title: "Daily review".to_string(),
            desc: "Review open pull requests".to_string(),
            trigger: "cron".to_string(),
            cron: "0 9 * * 1-5".to_string(),
            trigger_label: "weekday mornings".to_string(),
            next_run: "-".to_string(),
            enabled: true,
            last_run: None,
            last_status: None,
            delivery: "session".to_string(),
        }
    }

    #[test]
    fn migrates_legacy_desktop_schedules_before_gateway_reads_them() {
        let dir = std::env::temp_dir().join(format!("hone-schedule-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("schedules.json");
        std::fs::write(&path, serde_json::to_string(&vec![legacy_schedule("daily")]).unwrap()).unwrap();

        migrate_schedule_store(&dir);
        let entries = read_gateway_schedules(&path).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].trigger.kind, "cron");
        assert_eq!(entries[0].trigger.cron.as_deref(), Some("0 9 * * 1-5"));
        assert_eq!(entries[0].task, "Review open pull requests");
        assert_eq!(entries[0].delivery, "both");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn editing_schedule_preserves_gateway_run_history() {
        let existing = GatewayScheduleFileEntry {
            id: "daily".to_string(),
            text: "Old title".to_string(),
            trigger: GatewayScheduleTrigger {
                kind: "cron".to_string(), cron: Some("0 8 * * *".to_string()), ms: None, at: None,
            },
            task: "Old task".to_string(),
            delivery: "both".to_string(),
            enabled: true,
            created_at: 10,
            last_triggered_at: Some(20),
            last_status: Some("ok".to_string()),
        };

        let converted = ui_schedule_to_gateway(&legacy_schedule("daily"), Some(&existing)).unwrap();
        assert_eq!(converted.created_at, 10);
        assert_eq!(converted.last_triggered_at, Some(20));
        assert_eq!(converted.last_status.as_deref(), Some("ok"));
    }
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CanvasDocumentInfo {
    pub id: String,
    pub name: String,
    pub modified_at: String,
    pub content: String,
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

/// Return local canvas sessions together with their rendered document content.
/// The frontend intentionally does not get broad home-directory fs permission;
/// this IPC keeps ~/.hone access inside Rust where the target path is fixed.
#[tauri::command]
pub async fn canvas_documents_list() -> Result<Vec<CanvasDocumentInfo>, String> {
    const MAX_CANVAS_BYTES: u64 = 5 * 1024 * 1024;

    let sessions = canvas_sessions_list().await?;
    let home = dirs::home_dir().ok_or_else(|| "未找到 home 目录".to_string())?;
    let canvas_dir = home.join(".hone").join("canvas");
    let mut docs = Vec::new();

    for session in sessions {
        let session_dir = canvas_dir.join(&session.id);
        if !session_dir.is_dir() {
            continue;
        }

        let content_path = ["index.html", "content.md"]
            .iter()
            .map(|name| session_dir.join(name))
            .find(|path| path.is_file());

        let Some(path) = content_path else {
            continue;
        };

        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("读取 canvas 文件元数据失败: {}", e))?;
        if metadata.len() > MAX_CANVAS_BYTES {
            log::warn!("Skipping large canvas document: {}", path.display());
            continue;
        }

        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 canvas 文件失败: {}", e))?;
        if content.trim().is_empty() {
            continue;
        }

        docs.push(CanvasDocumentInfo {
            id: session.id,
            name: session.name,
            modified_at: session.modified_at,
            content,
        });
    }

    Ok(docs)
}

// ── User-managed Claude/Hone data commands ─────────────────────────────

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSyncInfo {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub desc_en: String,
    #[serde(default)]
    pub trigger: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct McpSyncInfo {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub url: String,
}

fn claude_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "未找到 home 目录".to_string())?;
    Ok(home.join(".claude"))
}

fn hone_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "未找到 home 目录".to_string())?;
    Ok(home.join(".hone"))
}

fn validate_managed_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if trimmed == "." || trimmed == ".." || trimmed.contains("..") {
        return Err(format!("名称不安全: {}", name));
    }
    if trimmed
        .chars()
        .any(|c| c == '/' || c == '\\' || c == ':' || c.is_control())
    {
        return Err(format!("名称不能包含路径或控制字符: {}", name));
    }
    Ok(trimmed.to_string())
}

fn quote_frontmatter_value(value: &str) -> String {
    let flattened = value.replace(['\r', '\n'], " ");
    let escaped = flattened.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

fn remove_dir_contents(dir: &std::path::Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败: {}", e))?;
        if file_type.is_dir() {
            std::fs::remove_dir_all(&path)
                .map_err(|e| format!("删除目录失败 {}: {}", path.display(), e))?;
        } else {
            std::fs::remove_file(&path)
                .map_err(|e| format!("删除文件失败 {}: {}", path.display(), e))?;
        }
    }

    Ok(())
}

/// Sync user-created skills from the desktop settings page to ~/.claude/skills.
/// Only files recorded in the Hone manifest are removed on later syncs, so this
/// does not wipe unrelated user skills that may already exist.
#[tauri::command]
pub async fn settings_sync_skills(skills: Vec<SkillSyncInfo>) -> Result<String, String> {
    let skills_dir = claude_dir()?.join("skills");
    std::fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("创建 skills 目录失败: {}", e))?;

    let manifest_path = skills_dir.join(".hone-managed-skills.json");
    let previous: Vec<String> = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    let mut current = Vec::new();
    for skill in skills.iter().filter(|skill| skill.enabled) {
        let name = validate_managed_name(&skill.name)?;
        current.push(name.clone());
    }

    for stale in previous.iter().filter(|name| !current.contains(name)) {
        let safe = validate_managed_name(stale)?;
        let path = skills_dir.join(format!("{}.md", safe));
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("删除旧技能失败 {}: {}", path.display(), e))?;
        }
    }

    for skill in skills.into_iter().filter(|skill| skill.enabled) {
        let name = validate_managed_name(&skill.name)?;
        let desc = if !skill.desc.trim().is_empty() {
            skill.desc.trim().to_string()
        } else if !skill.desc_en.trim().is_empty() {
            skill.desc_en.trim().to_string()
        } else if !skill.trigger.trim().is_empty() {
            skill.trigger.trim().to_string()
        } else {
            name.clone()
        };
        let content = format!(
            "---\ndescription: {}\n---\n\n{}\n",
            quote_frontmatter_value(&desc),
            desc
        );
        let path = skills_dir.join(format!("{}.md", name));
        let tmp = path.with_extension("md.tmp");
        std::fs::write(&tmp, &content)
            .map_err(|e| format!("写入技能失败 {}: {}", path.display(), e))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| format!("写入技能失败(重命名) {}: {}", path.display(), e))?;
    }

    let manifest = serde_json::to_string_pretty(&current)
        .map_err(|e| format!("序列化技能清单失败: {}", e))?;
    let tmp = manifest_path.with_extension("json.tmp");
    std::fs::write(&tmp, &manifest)
        .map_err(|e| format!("写入技能清单失败: {}", e))?;
    std::fs::rename(&tmp, &manifest_path)
        .map_err(|e| format!("写入技能清单失败(重命名): {}", e))?;

    Ok(format!("synced {} skill(s)", current.len()))
}

// ── Skills v2: Agent Skills 规范 (SKILL.md) ──

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillConfigV2 {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub compatibility: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub instructions: String,
    pub enabled: bool,
}

/// Validate skill name per Agent Skills spec: lowercase + digits + hyphens, 1-64 chars.
fn validate_skill_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("技能名称长度必须为 1-64 字符".to_string());
    }
    if trimmed.starts_with('-') || trimmed.ends_with('-') || trimmed.contains("--") {
        return Err("技能名称不能以连字符开头/结尾或连续连字符".to_string());
    }
    if !trimmed.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err("技能名称只能包含小写字母、数字和连字符".to_string());
    }
    Ok(trimmed.to_string())
}

/// Sync skills to ~/.codex/skills/{name}/SKILL.md (Agent Skills open format).
#[tauri::command]
pub async fn settings_sync_skills_v2(skills: Vec<SkillConfigV2>) -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| "未找到 home 目录".to_string())?;
    let skills_dir = home.join(".codex").join("skills");
    std::fs::create_dir_all(&skills_dir)
        .map_err(|e| format!("创建 skills 目录失败: {}", e))?;

    let manifest_path = skills_dir.join(".hone-managed-skills.json");
    let prev: Vec<String> = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    let mut current = Vec::new();

    // Remove stale skills
    for stale in prev.iter().filter(|n| !skills.iter().any(|s| s.name == **n && s.enabled)) {
        let dir = skills_dir.join(stale);
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    // Write current skills
    for skill in skills.into_iter().filter(|s| s.enabled) {
        let name = validate_skill_name(&skill.name)?;
        let skill_dir = skills_dir.join(&name);
        std::fs::create_dir_all(&skill_dir)
            .map_err(|e| format!("创建技能目录失败 {}: {}", skill_dir.display(), e))?;

        let mut fm = format!("---\nname: {}\ndescription: {}\n", name, quote_frontmatter_value(&skill.description));
        if let Some(lic) = &skill.license {
            if !lic.trim().is_empty() { fm.push_str(&format!("license: {}\n", quote_frontmatter_value(lic))); }
        }
        if let Some(comp) = &skill.compatibility {
            if !comp.trim().is_empty() { fm.push_str(&format!("compatibility: {}\n", quote_frontmatter_value(comp))); }
        }
        if let Some(meta) = &skill.metadata {
            if let Some(obj) = meta.as_object() {
                if !obj.is_empty() {
                    fm.push_str("metadata:\n");
                    for (k, v) in obj {
                        fm.push_str(&format!("  {}: {}\n", k, v));
                    }
                }
            }
        }
        if let Some(tools) = &skill.allowed_tools {
            if !tools.is_empty() {
                fm.push_str(&format!("allowed-tools: {}\n", tools.join(" ")));
            }
        }
        fm.push_str("---\n\n");

        let body = if skill.instructions.trim().is_empty() {
            format!("# {}\n\n{}", name, skill.description)
        } else {
            skill.instructions.clone()
        };
        let content = format!("{}{}", fm, body);

        let skill_file = skill_dir.join("SKILL.md");
        let tmp = skill_dir.join(".SKILL.md.tmp");
        std::fs::write(&tmp, &content)
            .map_err(|e| format!("写入技能失败 {}: {}", skill_file.display(), e))?;
        std::fs::rename(&tmp, &skill_file)
            .map_err(|e| format!("写入技能失败(重命名) {}: {}", skill_file.display(), e))?;

        current.push(name);
    }

    let manifest_raw = serde_json::to_string_pretty(&current)
        .map_err(|e| format!("序列化清单失败: {}", e))?;
    let mtmp = manifest_path.with_extension("json.tmp");
    std::fs::write(&mtmp, &manifest_raw)
        .map_err(|e| format!("写入清单失败: {}", e))?;
    std::fs::rename(&mtmp, &manifest_path)
        .map_err(|e| format!("写入清单失败(重命名): {}", e))?;

    Ok(format!("synced {} skill(s)", current.len()))
}

// ── 扫描本地 skills ──

/// Scan local directories for SKILL.md files and parse them into SkillConfigV2.
/// If custom_path is provided, scans only that directory.
/// Otherwise scans: ~/.trae-cn/skills/, ~/.codex/skills/, ~/.claude/skills/
#[tauri::command]
pub async fn skills_scan_local(custom_path: Option<String>) -> Result<Vec<SkillConfigV2>, String> {
    let mut scan_dirs: Vec<std::path::PathBuf> = Vec::new();

    if let Some(path) = custom_path {
        let p = std::path::PathBuf::from(path);
        if !p.exists() {
            return Err(format!("路径不存在: {}", p.display()));
        }
        scan_dirs.push(p);
    } else {
        let home = dirs::home_dir().ok_or_else(|| "未找到 home 目录".to_string())?;
        scan_dirs.push(home.join(".trae-cn").join("skills"));
        scan_dirs.push(home.join(".codex").join("skills"));
        scan_dirs.push(home.join(".claude").join("skills"));
    }

    let mut results: Vec<SkillConfigV2> = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    for scan_dir in &scan_dirs {
        if !scan_dir.exists() {
            continue;
        }
        let entries = std::fs::read_dir(scan_dir)
            .map_err(|e| format!("读取目录失败 {}: {}", scan_dir.display(), e))?;

        for entry in entries.flatten() {
            let path = entry.path();
            let skill_file = path.join("SKILL.md");
            if !skill_file.exists() {
                continue;
            }

            let raw = match std::fs::read_to_string(&skill_file) {
                Ok(content) => content,
                Err(_) => continue,
            };

            // Parse YAML frontmatter between --- delimiters
            let (frontmatter, body) = parse_skill_md(&raw);

            // Extract fields from frontmatter
            let name = extract_yaml_field(&frontmatter, "name")
                .unwrap_or_else(|| path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
            let description = extract_yaml_field(&frontmatter, "description").unwrap_or_default();
            let license = extract_yaml_field(&frontmatter, "license");
            let compatibility = extract_yaml_field(&frontmatter, "compatibility");
            let allowed_tools_str = extract_yaml_field(&frontmatter, "allowed-tools");

            // Skip duplicates (first occurrence wins)
            let name_lower = name.trim().to_lowercase();
            if seen_names.contains(&name_lower) {
                continue;
            }
            seen_names.insert(name_lower);

            let allowed_tools: Option<Vec<String>> = allowed_tools_str
                .map(|s| s.split_whitespace().map(String::from).collect());

            // Parse metadata as serde_json::Value if present
            let metadata = extract_yaml_metadata(&frontmatter);

            let skill = SkillConfigV2 {
                id: format!("local_{}", name),
                name,
                description,
                license,
                compatibility,
                metadata,
                allowed_tools,
                instructions: body,
                enabled: true,
            };
            results.push(skill);
        }
    }

    Ok(results)
}

/// Parse SKILL.md content into (frontmatter, body).
/// Frontmatter is between --- delimiters at the start of the file.
fn parse_skill_md(raw: &str) -> (String, String) {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return (String::new(), raw.to_string());
    }
    // Skip the opening ---
    let after_open = &trimmed[3..];
    // Find the closing ---
    if let Some(end) = after_open.find("\n---") {
        let frontmatter = after_open[..end].trim().to_string();
        let body = after_open[end + 4..].trim_start().to_string();
        (frontmatter, body)
    } else {
        (String::new(), raw.to_string())
    }
}

/// Extract a simple field value from YAML frontmatter text (no nesting).
/// Handles: `key: value` and `key: "value"` and `key: 'value'`
fn extract_yaml_field(frontmatter: &str, key: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        // Look for `key: value` pattern at the start of the line (no leading spaces for top-level keys)
        if let Some(rest) = trimmed.strip_prefix(&format!("{}:", key)) {
            let value = rest.trim();
            // Remove surrounding quotes
            let value = value.trim_matches('"').trim_matches('\'').to_string();
            if value.is_empty() {
                return None;
            }
            return Some(value);
        }
    }
    None
}

/// Extract metadata block from YAML frontmatter as a serde_json::Value.
/// Looks for lines like `metadata:` followed by indented `  key: value` lines.
fn extract_yaml_metadata(frontmatter: &str) -> Option<serde_json::Value> {
    let lines: Vec<&str> = frontmatter.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if line.trim() == "metadata:" {
            let mut obj = serde_json::Map::new();
            for subsequent_line in lines.iter().skip(i + 1) {
                let trimmed = subsequent_line.trim();
                // Stop when we hit a non-indented line (same level as metadata:)
                if !subsequent_line.starts_with(' ') && !subsequent_line.starts_with('\t') {
                    break;
                }
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                // Parse `  key: value` or `  key: "value"`
                if let Some(colon_idx) = trimmed.find(':') {
                    let k = trimmed[..colon_idx].trim().to_string();
                    let v = trimmed[colon_idx + 1..].trim().trim_matches('"').trim_matches('\'').to_string();
                    if !k.is_empty() {
                        obj.insert(k, serde_json::json!(v));
                    }
                }
            }
            if !obj.is_empty() {
                return Some(serde_json::Value::Object(obj));
            }
            return None;
        }
    }
    None
}

/// Sync MCP server URLs to ~/.claude/.mcp.json.
#[tauri::command]
pub async fn settings_sync_mcps(mcps: Vec<McpSyncInfo>) -> Result<String, String> {
    let dir = claude_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 .claude 目录失败: {}", e))?;

    let mut mcp_servers = serde_json::Map::new();
    for mcp in mcps {
        if mcp.url.trim().is_empty() {
            continue;
        }
        let name = validate_managed_name(&mcp.name)?;
        mcp_servers.insert(
            name,
            serde_json::json!({ "url": mcp.url.trim() }),
        );
    }

    let content = serde_json::json!({ "mcpServers": mcp_servers });
    let path = dir.join(".mcp.json");
    let raw = serde_json::to_string_pretty(&content)
        .map_err(|e| format!("序列化 MCP 配置失败: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &raw)
        .map_err(|e| format!("写入 MCP 配置失败 {}: {}", path.display(), e))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("写入 MCP 配置失败(重命名) {}: {}", path.display(), e))?;

    Ok(format!(
        "synced {} MCP server(s)",
        content
            .get("mcpServers")
            .and_then(|v| v.as_object())
            .map(|o| o.len())
            .unwrap_or(0)
    ))
}

// ── MCP v2: stdio / sse / streamable-http ──

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerV2 {
    pub id: String,
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub enabled: bool,
}

/// Sync MCP servers to claude_desktop_config.json (standard MCP format).
#[tauri::command]
pub async fn settings_sync_mcps_v2(mcps: Vec<McpServerV2>) -> Result<String, String> {
    let config_dir = if cfg!(target_os = "macos") {
        dirs::home_dir()
            .map(|h| h.join("Library").join("Application Support").join("Claude"))
    } else {
        dirs::data_dir()
            .map(|d| d.join("Claude"))
    }
    .ok_or_else(|| "无法确定 Claude 配置目录".to_string())?;

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("创建 Claude 配置目录失败: {}", e))?;

    let config_path = config_dir.join("claude_desktop_config.json");
    let manifest_path = config_dir.join(".hone-managed-mcps.json");

    let mut existing: serde_json::Value = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({ "mcpServers": {} }));

    let existing_servers = existing
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "claude_desktop_config.json 格式错误".to_string())?;

    let prev_managed: Vec<String> = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    for name in &prev_managed {
        existing_servers.remove(name);
    }

    let mut current_managed = Vec::new();
    for mcp in mcps.into_iter().filter(|m| m.enabled) {
        let raw_name = if mcp.name.trim().is_empty() { &mcp.id } else { &mcp.name };
        let name = validate_managed_name(raw_name)?;
        let server_config = match mcp.transport.as_str() {
            "stdio" => {
                let mut obj = serde_json::Map::new();
                if let Some(cmd) = &mcp.command {
                    obj.insert("command".into(), serde_json::json!(cmd));
                }
                if let Some(args) = &mcp.args {
                    obj.insert("args".into(), serde_json::json!(args));
                }
                if let Some(env) = &mcp.env {
                    if !env.is_empty() {
                        obj.insert("env".into(), serde_json::json!(env));
                    }
                }
                serde_json::Value::Object(obj)
            }
            "sse" => {
                serde_json::json!({ "url": mcp.url.as_deref().unwrap_or("") })
            }
            "streamable-http" => {
                let mut obj = serde_json::Map::new();
                obj.insert("type".into(), serde_json::json!("streamable-http"));
                if let Some(url) = &mcp.url {
                    obj.insert("url".into(), serde_json::json!(url));
                }
                if let Some(headers) = &mcp.headers {
                    if !headers.is_empty() {
                        obj.insert("headers".into(), serde_json::json!(headers));
                    }
                }
                serde_json::Value::Object(obj)
            }
            other => return Err(format!("未知传输类型: {}", other)),
        };
        existing_servers.insert(name.clone(), server_config);
        current_managed.push(name);
    }

    let raw = serde_json::to_string_pretty(&existing)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    let tmp = config_path.with_extension("json.tmp");
    std::fs::write(&tmp, &raw)
        .map_err(|e| format!("写入配置失败 {}: {}", config_path.display(), e))?;
    std::fs::rename(&tmp, &config_path)
        .map_err(|e| format!("写入配置失败(重命名) {}: {}", config_path.display(), e))?;

    let manifest_raw = serde_json::to_string_pretty(&current_managed)
        .map_err(|e| format!("序列化清单失败: {}", e))?;
    let mtmp = manifest_path.with_extension("json.tmp");
    std::fs::write(&mtmp, &manifest_raw)
        .map_err(|e| format!("写入清单失败: {}", e))?;
    std::fs::rename(&mtmp, &manifest_path)
        .map_err(|e| format!("写入清单失败(重命名): {}", e))?;

    Ok(format!("synced {} MCP server(s)", current_managed.len()))
}

/// Clear Hone runtime data managed by the desktop app.
#[tauri::command]
pub async fn settings_clear_user_data(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let secret_id = {
        let mut gw = state
            .gateway
            .lock()
            .map_err(|e| format!("Failed to acquire gateway lock: {}", e))?;
        let secret_id = gw.config().secret_id;
        let _ = gw.stop();
        secret_id
    };

    // gateway-config.json is redacted, so a complete reset must also remove
    // the matching native credential-store entry.
    secret_store::delete(&secret_id)
        .map_err(|e| format!("删除系统凭据失败: {}", e))?;

    let hone = hone_dir()?;
    remove_dir_contents(&hone)?;
    std::fs::create_dir_all(&hone).map_err(|e| format!("重建 .hone 目录失败: {}", e))?;

    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    for name in [
        "gateway-config.json",
        "schedules.json",
        "execution_log.json",
        "machines.json",
    ] {
        let path = data_dir.join(name);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("删除应用数据失败 {}: {}", path.display(), e))?;
        }
    }

    Ok("cleared user data".to_string())
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

    // 并发限制：acquire permit，随 tokio::spawn 任务结束自动 drop 释放
    let permit = state
        .cli_task_semaphore
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "cli_task semaphore closed".to_string())?;

    // Spawn in a tokio task so cli_task_run returns immediately
    tokio::spawn(async move {
        let _permit = permit; // 持有 permit 直到任务结束
        let mut cmd = tokio::process::Command::new(&node_path_for_spawn);
        cmd.arg(&cli_js)
            .arg("-p")
            .arg(&task_for_spawn)
            .current_dir(&cwd_for_spawn)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null());

        for (key, value) in crate::windows_proxy::env_vars() {
            cmd.env(key, value);
        }

        crate::windows_git_bash::apply_to_command(cmd.as_std_mut());

        // On Windows hide console window for the child node process
        #[cfg(windows)]
        {
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

        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                let _ = app_handle.emit(&event_done, serde_json::json!({
                    "task_id": task_id_for_spawn,
                    "status": "error",
                    "error": "stdout pipe failed",
                }));
                return;
            }
        };
        let stderr = match child.stderr.take() {
            Some(s) => s,
            None => {
                let _ = app_handle.emit(&event_done, serde_json::json!({
                    "task_id": task_id_for_spawn,
                    "status": "error",
                    "error": "stderr pipe failed",
                }));
                return;
            }
        };

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
    let mut env = vec![
        ("FORCE_COLOR".to_string(), "1".to_string()),
        ("TERM".to_string(), "xterm-256color".to_string()),
    ];
    env.extend(crate::windows_proxy::env_vars());

    if let Some(git_bash) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH") {
        if std::path::Path::new(&git_bash).is_file() {
            env.push((
                "CLAUDE_CODE_GIT_BASH_PATH".to_string(),
                git_bash.to_string_lossy().to_string(),
            ));
        }
    }

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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExecutionLog {
    pub schedule_id: String,
    pub triggered_at: String,
    pub status: String,
    pub output: String,
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn execution_log_list(
    app: tauri::AppHandle,
) -> Result<Vec<ExecutionLog>, String> {
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
    let logs: Vec<ExecutionLog> = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("execution_log_list: JSON parse failed ({}), returning empty", e);
            Vec::new()
        }
    };
    Ok(logs)
}
