//! Long-lived access token storage backed by the OS-native secure store
//! (macOS Keychain / Windows Credential Manager) via the `keyring` crate.
//!
//! Tokens are keyed by profile id under a single service name. They never touch
//! the config file or any export, so shared layouts can't leak credentials.

use keyring::Entry;

const SERVICE: &str = "ha-desktop-widget";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("keychain error: {0}")]
    Keyring(#[from] keyring::Error),
}

fn entry(profile_id: &str) -> Result<Entry, SecretError> {
    Ok(Entry::new(SERVICE, profile_id)?)
}

/// Store (or replace) the token for a profile.
pub fn set_token(profile_id: &str, token: &str) -> Result<(), SecretError> {
    entry(profile_id)?.set_password(token)?;
    Ok(())
}

/// Fetch the token for a profile, if one is stored.
pub fn get_token(profile_id: &str) -> Result<Option<String>, SecretError> {
    match entry(profile_id)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Whether a token exists for a profile (without returning it to the caller).
pub fn has_token(profile_id: &str) -> bool {
    matches!(get_token(profile_id), Ok(Some(_)))
}

/// Remove the token for a profile (e.g. when the profile is deleted). A missing
/// entry is treated as success.
pub fn delete_token(profile_id: &str) -> Result<(), SecretError> {
    match entry(profile_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
