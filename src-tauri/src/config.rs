//! Loading and saving the token-free config file in the OS-standard app config
//! directory, plus import/export helpers for sharing layouts.

use std::fs;
use std::path::{Path, PathBuf};

use crate::models::AppConfig;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid config json: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("unsupported config version: {0}")]
    Version(u32),
}

const FILE_NAME: &str = "config.json";
const SUPPORTED_VERSION: u32 = 1;

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// Load config from disk, returning the default config if no file exists yet.
pub fn load(dir: &Path) -> Result<AppConfig, ConfigError> {
    let path = config_path(dir);
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(&path)?;
    let cfg: AppConfig = serde_json::from_str(&raw)?;
    Ok(cfg)
}

/// Persist config atomically: write to a temp file in the same directory, then
/// rename over the target so a crash mid-write can't corrupt the config.
pub fn save(dir: &Path, cfg: &AppConfig) -> Result<(), ConfigError> {
    fs::create_dir_all(dir)?;
    let path = config_path(dir);
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(cfg)?;
    fs::write(&tmp, json.as_bytes())?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Serialise config for export. Tokens are never part of `AppConfig`, so the
/// exported JSON is inherently safe to share.
pub fn export_json(cfg: &AppConfig) -> Result<String, ConfigError> {
    Ok(serde_json::to_string_pretty(cfg)?)
}

/// Parse and validate imported JSON into an `AppConfig`.
pub fn import_json(raw: &str) -> Result<AppConfig, ConfigError> {
    let cfg: AppConfig = serde_json::from_str(raw)?;
    if cfg.version != SUPPORTED_VERSION {
        return Err(ConfigError::Version(cfg.version));
    }
    Ok(cfg)
}
