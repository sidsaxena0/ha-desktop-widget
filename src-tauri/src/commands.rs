//! The `#[tauri::command]` surface invoked from the webview. The webview never
//! receives tokens; it can only store/validate/delete them and send
//! `call_service` requests that the Rust side executes over the live socket.

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::app_state::{self, AppState};
use crate::ha_client::{fetch_areas, validate_token, TokenCheck};
use crate::models::{AppConfig, AreasResult};
use crate::{config, secrets};

// ---- Config / layout (token-free) ----

#[tauri::command]
pub fn get_config(state: State<AppState>) -> AppConfig {
    state.config_snapshot()
}

#[tauri::command]
pub async fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut guard = state.config.lock().unwrap();
        *guard = config.clone();
        config::save(&state.config_dir, &config).map_err(|e| e.to_string())?;
    }
    app_state::apply_settings(&app, &config.settings);
    crate::refresh_tray_menu(&app);
    // Config changed (URLs/profiles/active) — re-evaluate the connection.
    app_state::request_recheck(&app);
    Ok(())
}

#[tauri::command]
pub fn export_config(state: State<AppState>) -> Result<String, String> {
    let cfg = state.config_snapshot();
    config::export_json(&cfg).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_config(app: AppHandle, json: String) -> Result<AppConfig, String> {
    let imported = config::import_json(&json).map_err(|e| e.to_string())?;
    let state = app.state::<AppState>();
    {
        let mut guard = state.config.lock().unwrap();
        *guard = imported.clone();
        config::save(&state.config_dir, &imported).map_err(|e| e.to_string())?;
    }
    app_state::apply_settings(&app, &imported.settings);
    crate::refresh_tray_menu(&app);
    app_state::request_recheck(&app);
    Ok(imported)
}

// ---- Secrets (write-only from the UI's perspective) ----

#[tauri::command]
pub fn set_token(app: AppHandle, profile_id: String, token: String) -> Result<(), String> {
    secrets::set_token(&profile_id, &token).map_err(|e| e.to_string())?;
    app.state::<AppState>().cache_token(&profile_id, &token);
    Ok(())
}

#[tauri::command]
pub fn has_token(app: AppHandle, profile_id: String) -> bool {
    // Prefer the in-memory cache so opening Settings doesn't trigger a keychain
    // prompt; fall back to the keychain only on a miss.
    if app.state::<AppState>().token_for(&profile_id).is_some() {
        return true;
    }
    secrets::has_token(&profile_id)
}

#[tauri::command]
pub fn delete_token(app: AppHandle, profile_id: String) -> Result<(), String> {
    secrets::delete_token(&profile_id).map_err(|e| e.to_string())?;
    app.state::<AppState>().uncache_token(&profile_id);
    Ok(())
}

// ---- Home Assistant ----

#[tauri::command]
pub async fn ha_call_service(
    app: AppHandle,
    domain: String,
    service: String,
    data: Option<Value>,
    target: Option<Value>,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    state.ha.call_service(domain, service, data, target).await
}

/// Authenticated token check used by onboarding/settings. Distinct from the
/// reachability probe so the UI can tell "bad token" from "unreachable".
#[tauri::command]
pub async fn check_token(url: String, token: String) -> TokenCheck {
    validate_token(&url, &token).await
}

/// Fetch HA Areas (rooms) + each entity's area assignment for the live
/// connection. Returns an empty result if the registries can't be read.
#[tauri::command]
pub async fn ha_get_areas(app: AppHandle) -> AreasResult {
    let state = app.state::<AppState>();
    fetch_areas(&state.ha).await
}

/// Force a connection re-evaluation (manual refresh).
#[tauri::command]
pub fn reconnect(app: AppHandle) {
    app_state::request_recheck(&app);
}

// ---- Profile activation / network override ----

/// Manually pin the active profile. This is sticky for the session and
/// overrides auto-switching until `resume_auto_switch` is called.
#[tauri::command]
pub fn set_active_profile(app: AppHandle, profile_id: String) -> Result<(), String> {
    app_state::pin_profile(&app, profile_id)
}

/// Clear the sticky manual pin and resume reachability-driven auto-switching.
#[tauri::command]
pub fn resume_auto_switch(app: AppHandle) {
    app_state::resume_auto(&app);
}

/// Whether a sticky manual override is currently active (and which profile).
#[tauri::command]
pub fn get_manual_override(state: State<AppState>) -> Option<String> {
    state.manual_override.lock().unwrap().clone()
}
