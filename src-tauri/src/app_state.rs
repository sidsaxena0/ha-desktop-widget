//! Shared application state and the central "evaluate which house/URL we should
//! be on, then connect" routine.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::ha_client::HaManager;
use crate::models::{AppConfig, AppSettings, ConnectionStatus};
use crate::{config, network, secrets};

pub struct AppState {
    pub config_dir: PathBuf,
    pub config: Mutex<AppConfig>,
    pub ha: HaManager,
    /// Lenient client used only for reachability probes.
    pub probe: reqwest::Client,
    /// Sticky, session-only manual profile pin. When set it overrides
    /// auto-switching until the user resumes auto.
    pub manual_override: Mutex<Option<String>>,
    pub recheck_tx: tokio::sync::mpsc::UnboundedSender<()>,
    /// The system tray icon, set once during setup so its menu can be rebuilt
    /// when profiles change.
    pub tray: Mutex<Option<tauri::tray::TrayIcon>>,
    /// In-memory cache of profile_id -> token. The OS keychain is read at most
    /// once per profile per session, so macOS doesn't re-prompt on every
    /// reconnect / wake-from-sleep / re-check.
    pub token_cache: Mutex<HashMap<String, String>>,
}

impl AppState {
    /// Fetch a profile's token, reading the keychain only on a cache miss.
    pub fn token_for(&self, profile_id: &str) -> Option<String> {
        if let Some(t) = self.token_cache.lock().unwrap().get(profile_id) {
            return Some(t.clone());
        }
        match secrets::get_token(profile_id) {
            Ok(Some(t)) => {
                self.token_cache
                    .lock()
                    .unwrap()
                    .insert(profile_id.to_string(), t.clone());
                Some(t)
            }
            _ => None,
        }
    }

    /// Update the cached token (after the UI stores a new one).
    pub fn cache_token(&self, profile_id: &str, token: &str) {
        self.token_cache
            .lock()
            .unwrap()
            .insert(profile_id.to_string(), token.to_string());
    }

    /// Drop a cached token (after delete).
    pub fn uncache_token(&self, profile_id: &str) {
        self.token_cache.lock().unwrap().remove(profile_id);
    }
}

impl AppState {
    /// Take a cheap clone of the current config for read-only use off-thread.
    pub fn config_snapshot(&self) -> AppConfig {
        self.config.lock().unwrap().clone()
    }
}

/// Apply user-facing settings to the live app (window + autostart).
pub fn apply_settings(app: &AppHandle, settings: &AppSettings) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_always_on_top(settings.always_on_top);
    }
    let launcher = app.autolaunch();
    let enabled = launcher.is_enabled().unwrap_or(false);
    if settings.autostart && !enabled {
        let _ = launcher.enable();
    } else if !settings.autostart && enabled {
        let _ = launcher.disable();
    }
}

/// The heart of network awareness: pick the active profile + URL via the
/// reachability-first logic, then (re)point the HA client at it.
///
/// Called on launch, on the recheck timer, on window focus, on WS disconnect,
/// and whenever the user changes profiles/config.
pub async fn evaluate_and_apply(app: AppHandle) {
    let state = app.state::<AppState>();

    let (profiles, active_id, auto_switch) = {
        let cfg = state.config.lock().unwrap();
        (
            cfg.profiles.clone(),
            cfg.active_profile_id.clone(),
            cfg.settings.auto_switch_by_location,
        )
    };

    if profiles.is_empty() {
        state.ha.disconnect().await;
        return;
    }

    let manual = state.manual_override.lock().unwrap().clone();

    let selection = network::select_connection(
        &state.probe,
        &profiles,
        active_id.as_deref(),
        manual.as_deref(),
        auto_switch,
    )
    .await;

    let Some(sel) = selection else {
        return;
    };

    // Persist the active profile if it changed.
    {
        let mut cfg = state.config.lock().unwrap();
        if cfg.active_profile_id.as_deref() != Some(sel.profile_id.as_str()) {
            cfg.active_profile_id = Some(sel.profile_id.clone());
            let _ = config::save(&state.config_dir, &cfg);
        }
    }

    // Fetch the token (cached; keychain hit at most once per session).
    let token = match state.token_for(&sel.profile_id) {
        Some(t) => t,
        None => {
            state.ha.disconnect().await;
            let _ = app.emit(
                "ha://status",
                ConnectionStatus {
                    connected: false,
                    profile_id: Some(sel.profile_id.clone()),
                    url: Some(sel.url.clone()),
                    using_internal: sel.using_internal,
                    kind: "auth".into(),
                    message: Some("no token stored for this profile".into()),
                },
            );
            return;
        }
    };

    let _ = app.emit(
        "ha://active",
        json!({
            "profileId": sel.profile_id,
            "url": sel.url,
            "usingInternal": sel.using_internal,
            "manualOverride": manual.is_some(),
        }),
    );

    state
        .ha
        .set_target(sel.url, token, sel.profile_id, sel.using_internal)
        .await;
}

/// Ask the runtime to re-evaluate the connection. Non-blocking.
pub fn request_recheck(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = state.recheck_tx.send(());
}

/// Sticky-pin a profile (manual override). Used by both the command and the
/// tray menu.
pub fn pin_profile(app: &AppHandle, profile_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    *state.manual_override.lock().unwrap() = Some(profile_id.clone());
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.active_profile_id = Some(profile_id);
        config::save(&state.config_dir, &cfg).map_err(|e| e.to_string())?;
    }
    request_recheck(app);
    Ok(())
}

/// Clear the sticky pin and resume reachability-driven auto-switching.
pub fn resume_auto(app: &AppHandle) {
    let state = app.state::<AppState>();
    *state.manual_override.lock().unwrap() = None;
    request_recheck(app);
}
