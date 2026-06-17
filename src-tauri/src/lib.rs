//! Tauri application wiring: plugins, state, system tray, the network re-check
//! pipeline (timer + window focus + WS disconnect), and the command surface.

mod app_state;
mod commands;
mod config;
mod ha_client;
mod models;
mod network;
mod secrets;

use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use app_state::AppState;
use ha_client::HaManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Persist size/position/maximized, but NOT decorations or visibility — those
    // stay controlled by tauri.conf.json, so a stale persisted value can't strip
    // the window's title bar / controls.
    let window_state_flags = tauri_plugin_window_state::StateFlags::SIZE
        | tauri_plugin_window_state::StateFlags::POSITION
        | tauri_plugin_window_state::StateFlags::MAXIMIZED;

    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::export_config,
            commands::import_config,
            commands::set_token,
            commands::has_token,
            commands::delete_token,
            commands::ha_call_service,
            commands::check_token,
            commands::ha_get_areas,
            commands::reconnect,
            commands::set_active_profile,
            commands::resume_auto_switch,
            commands::get_manual_override,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // --- load config + build shared state ---
            let config_dir = app.path().app_config_dir()?;
            let cfg = config::load(&config_dir).unwrap_or_default();

            let (recheck_tx, mut recheck_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
            let ha = HaManager::new(handle.clone(), recheck_tx.clone());

            let state = AppState {
                config_dir,
                config: Mutex::new(cfg),
                ha,
                probe: network::probe_client(),
                manual_override: Mutex::new(None),
                recheck_tx,
                tray: Mutex::new(None),
                token_cache: Mutex::new(std::collections::HashMap::new()),
            };
            app.manage(state);

            // --- re-check pipeline: one serial consumer of recheck signals ---
            let loop_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                while recheck_rx.recv().await.is_some() {
                    app_state::evaluate_and_apply(loop_handle.clone()).await;
                }
            });

            // --- periodic re-check timer (honours the configured cadence) ---
            let timer_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let secs = timer_handle
                        .state::<AppState>()
                        .config
                        .lock()
                        .unwrap()
                        .settings
                        .network_recheck_interval_sec
                        .max(5);
                    tokio::time::sleep(Duration::from_secs(secs)).await;
                    app_state::request_recheck(&timer_handle);
                }
            });

            // --- re-check on window focus ("I just came back to the widget") ---
            if let Some(win) = app.get_webview_window("main") {
                let focus_handle = handle.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(true) = event {
                        app_state::request_recheck(&focus_handle);
                    }
                });
            }

            // --- system tray ---
            build_tray(&handle)?;

            // --- apply settings + kick off the first evaluation ---
            let settings = handle.state::<AppState>().config_snapshot().settings;
            app_state::apply_settings(&handle, &settings);
            app_state::request_recheck(&handle);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ha-desktop-widget");
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("HA Widget")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|tray, event| {
            // Left-click toggles the widget's visibility.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let tray = builder.build(app)?;
    *app.state::<AppState>().tray.lock().unwrap() = Some(tray);
    Ok(())
}

/// Rebuild the tray menu (e.g. after profiles change). Safe to call any time.
pub(crate) fn refresh_tray_menu(app: &AppHandle) {
    if let Ok(menu) = build_tray_menu(app) {
        if let Some(tray) = app.state::<AppState>().tray.lock().unwrap().as_ref() {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let cfg = app.state::<AppState>().config_snapshot();
    let active = cfg.active_profile_id.clone();

    let toggle = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;

    // One entry per profile; the active one is marked with a bullet.
    let mut profile_items = Vec::new();
    for p in &cfg.profiles {
        let label = if active.as_deref() == Some(p.id.as_str()) {
            format!("● {}", p.name)
        } else {
            format!("   {}", p.name)
        };
        profile_items.push(MenuItem::with_id(
            app,
            format!("profile:{}", p.id),
            label,
            true,
            None::<&str>,
        )?);
    }
    let profile_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = profile_items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<Wry>)
        .collect();
    let profiles_sub = Submenu::with_items(app, "Switch profile", true, &profile_refs)?;

    let resume = MenuItem::with_id(app, "resume_auto", "Resume auto-switch", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    Menu::with_items(app, &[&toggle, &profiles_sub, &resume, &sep, &quit])
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().0.as_str() {
        "toggle" => toggle_window(app),
        "resume_auto" => app_state::resume_auto(app),
        "quit" => app.exit(0),
        other => {
            if let Some(profile_id) = other.strip_prefix("profile:") {
                let _ = app_state::pin_profile(app, profile_id.to_string());
                refresh_tray_menu(app);
            }
        }
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(true) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}
