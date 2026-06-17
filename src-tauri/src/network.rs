//! Network awareness: reachability-first connection selection, with SSID used
//! only as a tie-breaker.
//!
//! The two checks here are deliberately distinct and never conflated:
//!   * `probe_reachable` is UNAUTHENTICATED and treats ANY HTTP response
//!     (including 401) as "reachable". It only answers "did I get an HTTP
//!     response within the timeout". No token is sent.
//!   * Token validity is a SEPARATE authenticated check, performed by the HA
//!     WebSocket client / onboarding (see `ha_client.rs`).

use std::time::Duration;

use futures_util::future::join_all;

use crate::models::Profile;

const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// The chosen connection target after evaluating reachability + SSID.
#[derive(Debug, Clone)]
pub struct Selection {
    pub profile_id: String,
    pub url: String,
    pub using_internal: bool,
}

/// A reachability probe client. Certificate validation is intentionally relaxed
/// because this only answers "did something respond" — HA LAN instances commonly
/// use self-signed certs. The authenticated connection in `ha_client.rs` uses a
/// strict TLS stack.
pub fn probe_client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(PROBE_TIMEOUT)
        .build()
        .expect("failed to build probe client")
}

/// Returns true if the URL produced ANY HTTP response within the timeout.
/// A 401 counts as reachable. Only transport failures (timeout / refused / DNS)
/// count as unreachable.
pub async fn probe_reachable(client: &reqwest::Client, base_url: &str) -> bool {
    let url = format!("{}/api/", base_url.trim_end_matches('/'));
    client.get(&url).send().await.is_ok()
}

/// Probe every profile's internal URL concurrently, returning the ids that
/// answered.
async fn reachable_profile_ids(client: &reqwest::Client, profiles: &[Profile]) -> Vec<String> {
    let checks = profiles.iter().map(|p| async move {
        if probe_reachable(client, &p.internal_url).await {
            Some(p.id.clone())
        } else {
            None
        }
    });
    join_all(checks).await.into_iter().flatten().collect()
}

fn find<'a>(profiles: &'a [Profile], id: &str) -> Option<&'a Profile> {
    profiles.iter().find(|p| p.id == id)
}

/// The reachability-first selection algorithm (see the plan's pseudocode).
///
/// `manual_override` is a sticky session pin from the tray/settings; when set it
/// wins outright. Otherwise, if `auto_switch` is off we keep the current
/// profile. When auto-switching, we probe internal URLs and use SSID only to
/// break ties / hint when nothing is reachable.
pub async fn select_connection(
    client: &reqwest::Client,
    profiles: &[Profile],
    current_profile_id: Option<&str>,
    manual_override: Option<&str>,
    auto_switch: bool,
) -> Option<Selection> {
    if profiles.is_empty() {
        return None;
    }

    let fallback_id = current_profile_id
        .and_then(|id| find(profiles, id))
        .map(|p| p.id.clone())
        .unwrap_or_else(|| profiles[0].id.clone());

    // ---- pick the ACTIVE PROFILE ----
    let chosen_id = if let Some(id) = manual_override.filter(|id| find(profiles, id).is_some()) {
        id.to_string()
    } else if !auto_switch {
        fallback_id.clone()
    } else {
        let reachable = reachable_profile_ids(client, profiles).await;
        match reachable.len() {
            1 => reachable[0].clone(),
            n if n > 1 => {
                // Tie: more than one internal URL answered. This happens when a
                // VPN/Tailscale address (reachable everywhere) competes with a
                // genuinely-local instance.
                let ssid = detect_ssid();
                if let Some(id) = ssid_matches(profiles, &reachable, ssid.as_deref()) {
                    // Strongest signal: an explicit SSID match (when SSID is
                    // readable — note macOS often redacts it).
                    id
                } else if let Some(id) = most_local(profiles, &reachable) {
                    // No SSID: prefer the genuinely LAN-local instance (mDNS
                    // `.local` / private IP) over an always-reachable VPN/CGNAT
                    // (e.g. Tailscale 100.64/10) or public address.
                    id
                } else {
                    fallback_id.clone()
                }
            }
            _ => {
                // Nothing internally reachable (away, or all internals down).
                // SSID may *hint* a profile but never forces a switch.
                let ssid = detect_ssid();
                let all_ids: Vec<String> = profiles.iter().map(|p| p.id.clone()).collect();
                match ssid_matches(profiles, &all_ids, ssid.as_deref()) {
                    Some(id) => id,
                    None => fallback_id.clone(),
                }
            }
        }
    };

    let profile = find(profiles, &chosen_id)?;

    // ---- pick the URL within that profile (always reachability-driven) ----
    let internal_ok = probe_reachable(client, &profile.internal_url).await;
    let (url, using_internal) = if internal_ok || profile.external_url.trim().is_empty() {
        // Use internal when it's reachable, or when there's no external to fall
        // back to (we'll keep trying internal and reconnect).
        (profile.internal_url.clone(), true)
    } else {
        (profile.external_url.clone(), false)
    };

    Some(Selection {
        profile_id: chosen_id,
        url,
        using_internal,
    })
}

/// Among `candidate_ids`, return the single profile whose SSID list contains the
/// current SSID. Returns None if the SSID is unknown or the match is ambiguous.
fn ssid_matches(
    profiles: &[Profile],
    candidate_ids: &[String],
    ssid: Option<&str>,
) -> Option<String> {
    let ssid = ssid?;
    let matches: Vec<String> = candidate_ids
        .iter()
        .filter(|id| {
            find(profiles, id)
                .map(|p| p.ssids.iter().any(|s| s == ssid))
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    if matches.len() == 1 {
        Some(matches[0].clone())
    } else {
        None
    }
}

/// Among `candidate_ids`, return the one whose internal URL is the most "local"
/// (LAN), if there's a unique winner. Tie-breaker when SSID is unavailable: a
/// genuinely-local address means we're physically on that network, whereas a
/// VPN/Tailscale address is reachable from anywhere.
fn most_local(profiles: &[Profile], candidate_ids: &[String]) -> Option<String> {
    let mut best_score = -1i32;
    let mut best_id: Option<String> = None;
    let mut tie = false;
    for id in candidate_ids {
        let Some(p) = find(profiles, id) else {
            continue;
        };
        let score = localness(&p.internal_url);
        if score > best_score {
            best_score = score;
            best_id = Some(id.clone());
            tie = false;
        } else if score == best_score {
            tie = true;
        }
    }
    if tie {
        None
    } else {
        best_id
    }
}

/// Score how "local" (LAN-only) a base URL's host is. Higher = more local.
///   3 = mDNS `.local` / loopback / private LAN IP (must be on that network)
///   1 = CGNAT 100.64.0.0/10 (Tailscale & co — reachable anywhere)
///   0 = public host / IP (remote)
fn localness(base_url: &str) -> i32 {
    let host = url_host(base_url).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") {
        return 3;
    }
    let octets: Vec<u8> = host.split('.').filter_map(|o| o.parse::<u8>().ok()).collect();
    if octets.len() == 4 {
        let (a, b) = (octets[0], octets[1]);
        if a == 127
            || a == 10
            || (a == 192 && b == 168)
            || (a == 172 && (16..=31).contains(&b))
            || (a == 169 && b == 254)
        {
            return 3;
        }
        if a == 100 && (64..=127).contains(&b) {
            return 1; // CGNAT (Tailscale)
        }
        return 0;
    }
    0
}

/// Extract the host from `scheme://host[:port][/path]`.
fn url_host(base_url: &str) -> String {
    let s = base_url.trim();
    let after = s.split_once("://").map(|(_, r)| r).unwrap_or(s);
    let host_port = after.split(['/', '?', '#']).next().unwrap_or(after);
    let host = host_port.rsplit_once(':').map(|(h, _)| h).unwrap_or(host_port);
    host.trim_matches(|c| c == '[' || c == ']').to_string()
}

// ---------------------------------------------------------------------------
// SSID detection — best-effort, OS-specific, used ONLY as a tie-breaker.
// Any failure (permissions, removed APIs on recent macOS, no WiFi) returns None,
// which the selection logic handles gracefully.
// ---------------------------------------------------------------------------

pub fn detect_ssid() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        detect_ssid_macos()
    }
    #[cfg(target_os = "windows")]
    {
        detect_ssid_windows()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        detect_ssid_linux()
    }
}

#[cfg(target_os = "macos")]
fn detect_ssid_macos() -> Option<String> {
    use std::process::Command;
    // `networksetup -getairportnetwork <iface>` prints:
    //   "Current Wi-Fi Network: <SSID>"
    // The WiFi interface is usually en0, occasionally en1.
    for iface in ["en0", "en1"] {
        if let Ok(out) = Command::new("networksetup")
            .args(["-getairportnetwork", iface])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some((_, ssid)) = text.trim().split_once(": ") {
                let ssid = ssid.trim();
                if !ssid.is_empty() && ssid != "<redacted>" {
                    return Some(ssid.to_string());
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn detect_ssid_windows() -> Option<String> {
    use std::process::Command;
    let out = Command::new("netsh")
        .args(["wlan", "show", "interfaces"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let line = line.trim();
        // Match the "SSID" line but not "BSSID".
        if line.starts_with("SSID") && !line.starts_with("BSSID") {
            if let Some((_, ssid)) = line.split_once(':') {
                let ssid = ssid.trim();
                if !ssid.is_empty() {
                    return Some(ssid.to_string());
                }
            }
        }
    }
    None
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn detect_ssid_linux() -> Option<String> {
    use std::process::Command;
    let out = Command::new("iwgetid").arg("-r").output().ok()?;
    let ssid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if ssid.is_empty() {
        None
    } else {
        Some(ssid)
    }
}
