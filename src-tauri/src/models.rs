//! Serialisable data shared between the Rust core, the on-disk config file, and
//! the webview. Field names use camelCase so they map 1:1 onto the TypeScript
//! types in `src/types.ts` and onto the JSON config file.

use serde::{Deserialize, Serialize};

/// Top-level config persisted to `app_config_dir/config.json`.
///
/// IMPORTANT: this struct intentionally contains **no secrets**. Long-lived
/// access tokens live in the OS keychain (see `secrets.rs`) keyed by profile id,
/// so the config file is always safe to share / commit / export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub version: u32,
    #[serde(default)]
    pub active_profile_id: Option<String>,
    #[serde(default)]
    pub settings: AppSettings,
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            version: 1,
            active_profile_id: None,
            settings: AppSettings::default(),
            profiles: Vec::new(),
        }
    }
}

impl AppConfig {
    // Convenience lookups used by tooling/tests and future call sites.
    #[allow(dead_code)]
    pub fn profile(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// The active profile, falling back to the first profile if the stored
    /// active id is missing or dangling.
    #[allow(dead_code)]
    pub fn active_profile(&self) -> Option<&Profile> {
        self.active_profile_id
            .as_deref()
            .and_then(|id| self.profile(id))
            .or_else(|| self.profiles.first())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Launch the widget at login (mirrors the autostart plugin state).
    pub autostart: bool,
    /// Keep the window above all others.
    pub always_on_top: bool,
    /// When true, the reachability probe auto-selects the active profile.
    /// When false, the user's manually-selected profile is kept (URL within it
    /// is still chosen by reachability — see `network.rs`).
    pub auto_switch_by_location: bool,
    /// How often (seconds) to re-evaluate which house/URL we should be on.
    /// This is a *network* re-check cadence — entity state is pushed over the
    /// WebSocket, never polled.
    pub network_recheck_interval_sec: u64,
    /// UI theme: `"light"` (default) or `"dark"`.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Show HA `config`/`diagnostic` entities (sub-controls like "LED", "Auto-off").
    /// Off by default — these clutter the grid and aren't real devices.
    #[serde(default)]
    pub show_config_entities: bool,
}

fn default_theme() -> String {
    "light".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            autostart: false,
            always_on_top: false,
            auto_switch_by_location: true,
            network_recheck_interval_sec: 30,
            theme: default_theme(),
            show_config_entities: false,
        }
    }
}

/// A "house": one Home Assistant instance with its own URLs, WiFi hints,
/// token (stored separately in the keychain), and entity layout.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// LAN URL, e.g. `http://192.168.1.10:8123` (an IP is preferred over
    /// `homeassistant.local` because mDNS is flaky, especially on Windows).
    pub internal_url: String,
    /// Remote URL, e.g. a Nabu Casa / reverse-proxy address. Optional.
    #[serde(default)]
    pub external_url: String,
    /// WiFi SSIDs that hint at this house. Used ONLY as a tie-breaker when more
    /// than one profile's internal URL is reachable.
    #[serde(default)]
    pub ssids: Vec<String>,
    #[serde(default)]
    pub groups: Vec<Group>,
    /// Per-entity overrides (label / icon / custom-group). Only entities the
    /// user has customized appear here; everything else uses HA defaults.
    #[serde(default)]
    pub entities: Vec<EntityConfig>,
    /// Entity ids the user has starred (pinned). Empty ⇒ show everything.
    #[serde(default)]
    pub favorites: Vec<String>,
    /// UI preference: show only favorites (ignored when `favorites` is empty).
    #[serde(default)]
    pub favorites_only: bool,
    /// Grouping mode for the grid: `"room"` (HA Areas, default) or `"custom"`
    /// (the manual `groups` above).
    #[serde(default = "default_group_by")]
    pub group_by: String,
    /// Sort mode within a group: `"name"` (default) or `"manual"`
    /// (user drag order via each entity's `order`).
    #[serde(default = "default_sort_by")]
    pub sort_by: String,
}

fn default_group_by() -> String {
    "room".to_string()
}

fn default_sort_by() -> String {
    "name".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityConfig {
    pub entity_id: String,
    /// User-facing label override. Falls back to HA's friendly_name in the UI.
    #[serde(default)]
    pub label: String,
    /// Material Design Icons name (e.g. `mdi:lamp`) or an emoji. Optional.
    #[serde(default)]
    pub icon: String,
    /// Owning group id, or empty for "ungrouped".
    #[serde(default)]
    pub group_id: String,
    /// Accent colour override (CSS hex, e.g. `#ff8a3d`), or empty for default.
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub order: i32,
}

/// A live entity state snapshot pushed to the webview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityState {
    pub entity_id: String,
    pub state: String,
    /// Raw HA attributes (brightness, friendly_name, temperature, etc.).
    #[serde(default)]
    pub attributes: serde_json::Value,
}

/// Connection lifecycle pushed to the webview as the `ha://status` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub connected: bool,
    pub profile_id: Option<String>,
    pub url: Option<String>,
    /// Whether the active URL is the internal (LAN) one.
    pub using_internal: bool,
    /// Distinguishes a *token* problem from a *network* problem so the UI can
    /// message precisely. One of: "ok" | "connecting" | "network" | "auth".
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// A Home Assistant Area (room).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaInfo {
    pub id: String,
    pub name: String,
}

/// Maps an entity to its resolved Area id (entity's own area, else its device's).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityArea {
    pub entity_id: String,
    pub area_id: String,
}

/// Registry metadata used to filter clutter: `category` is "config" /
/// "diagnostic" / "" and `hidden` mirrors HA's hidden_by.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityMeta {
    pub entity_id: String,
    pub category: String,
    pub hidden: bool,
}

/// Result of `ha_get_areas`: the room list, each entity's area assignment, and
/// per-entity registry metadata for filtering.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AreasResult {
    pub areas: Vec<AreaInfo>,
    pub entity_areas: Vec<EntityArea>,
    pub entity_meta: Vec<EntityMeta>,
}
