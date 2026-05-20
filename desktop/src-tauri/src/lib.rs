use tauri::Manager;

mod commands;
mod gateway_manager;
mod machine_registry;
mod mdns_discovery;
mod pty_manager;
mod scheduler;
mod ssh_tunnel;
mod windows_git_bash;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        .setup(commands::setup)
        .invoke_handler(tauri::generate_handler![
            commands::gateway_start,
            commands::gateway_stop,
            commands::gateway_status,
            commands::gateway_uptime,
            commands::machines_list,
            commands::machine_add,
            commands::machine_remove,
            commands::machine_update_status,
            commands::discover_gateways,
            commands::ssh_connect,
            commands::ssh_disconnect,
            commands::ssh_execute,
            commands::get_hone_path,
            commands::set_hone_path,
            commands::pair_with_local_cli,
            commands::local_cli_instances_list,
            commands::test_provider,
            commands::get_config,
            commands::save_config,
            commands::schedules_list,
            commands::schedules_save,
            commands::autostart_is_enabled,
            commands::autostart_toggle,
            commands::execution_log_list,
            commands::canvas_sessions_list,
            commands::cli_task_run,
            commands::pty_open,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_close,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<commands::AppState>();
                if let Ok(mut gateway) = state.gateway.lock() {
                    let _ = gateway.stop();
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Hone");
}
