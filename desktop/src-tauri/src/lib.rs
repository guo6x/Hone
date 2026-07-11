use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

mod commands;
mod gateway_manager;
mod machine_registry;
mod mdns_discovery;
mod pty_manager;
mod secret_store;
mod ssh_tunnel;
mod windows_git_bash;
mod windows_proxy;

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
        .setup(|app| {
            commands::setup(app)?;

            // Closing the main window keeps the gateway alive. The tray menu
            // is the explicit control surface for restoring or terminating
            // the desktop process.
            let show = MenuItem::with_id(app, "show", "Show Hone", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Hone", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("missing application icon for tray")?;
            TrayIconBuilder::with_id("hone-tray")
                .icon(icon)
                .tooltip("Hone")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
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
            commands::provider_fetch_models,
            commands::get_config,
            commands::gateway_connection_info,
            commands::mobile_pairing_rotate,
            commands::save_config,
            commands::schedules_list,
            commands::schedules_save,
            commands::autostart_is_enabled,
            commands::autostart_toggle,
            commands::execution_log_list,
            commands::canvas_sessions_list,
            commands::canvas_documents_list,
            commands::settings_sync_skills,
            commands::settings_sync_skills_v2,
            commands::skills_scan_local,
            commands::settings_sync_mcps,
            commands::settings_sync_mcps_v2,
            commands::settings_clear_user_data,
            commands::cli_task_run,
            commands::pty_open,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_close,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                return;
            }

            // Destroyed only occurs after an explicit application exit, not
            // after the regular close-to-tray action above.
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<commands::AppState>();
                if let Ok(mut gateway) = state.gateway.lock() {
                    if let Err(e) = gateway.stop() {
                        log::warn!("Gateway stop on exit failed: {}", e);
                    }
                }
                state.pty.close_all();
                if let Ok(mut ssh) = state.ssh.lock() {
                    if let Some(tunnel) = ssh.as_mut() {
                        let _ = tunnel.disconnect();
                    }
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Hone");
}
