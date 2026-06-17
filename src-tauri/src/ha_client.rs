//! Home Assistant WebSocket client. The Rust side owns the connection AND the
//! token — the token is never handed to the webview. The webview receives state
//! via Tauri events (`ha://status`, `ha://states`, `ha://state`) and sends
//! commands back through `call_service`.
//!
//! Connection lifecycle (one attempt = `connect_once`):
//!   1. open WS, read `auth_required`
//!   2. send `auth` with the token; read `auth_ok` / `auth_invalid`
//!   3. `subscribe_events: state_changed` — subscribed BEFORE `get_states` so a
//!      state change between snapshot and subscription can't be missed
//!   4. `get_states` for the initial snapshot
//!   5. loop: forward incoming state changes, route command results, ping
//!
//! An `auth_invalid` is surfaced as a *token* error and does NOT trigger a
//! reconnect storm; network failures reconnect with backoff and ask the app to
//! re-evaluate which house/URL it should be on ("I may have left the house").

use std::collections::HashMap;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::models::{AreaInfo, AreasResult, ConnectionStatus, EntityArea, EntityMeta, EntityState};

/// A request to send over the live connection, with a channel for its result.
struct Outgoing {
    payload: Value,
    responder: oneshot::Sender<Result<Value, String>>,
}

struct ConnectionHandle {
    signature: String,
    task: tokio::task::JoinHandle<()>,
    out_tx: mpsc::Sender<Outgoing>,
}

/// Manages the single active HA connection. Switching targets aborts the old
/// connection task and spawns a new one.
pub struct HaManager {
    inner: Mutex<Option<ConnectionHandle>>,
    app: AppHandle,
    recheck_tx: mpsc::UnboundedSender<()>,
}

enum ConnResult {
    /// Bad/expired token — surfaced distinctly, no reconnect storm.
    AuthFailed(String),
    /// Transport-level loss — reconnect with backoff.
    Disconnected(String),
}

impl HaManager {
    pub fn new(app: AppHandle, recheck_tx: mpsc::UnboundedSender<()>) -> Self {
        HaManager {
            inner: Mutex::new(None),
            app,
            recheck_tx,
        }
    }

    /// Point the connection at `url` using `token`. If we're already connected to
    /// the same (url, profile, token) and the task is alive, this is a no-op.
    pub async fn set_target(
        &self,
        url: String,
        token: String,
        profile_id: String,
        using_internal: bool,
    ) {
        let signature = format!("{url}|{profile_id}|{token}");
        let mut guard = self.inner.lock().await;
        if let Some(h) = guard.as_ref() {
            if h.signature == signature && !h.task.is_finished() {
                return;
            }
        }
        if let Some(old) = guard.take() {
            old.task.abort();
        }

        let (out_tx, out_rx) = mpsc::channel::<Outgoing>(16);
        let app = self.app.clone();
        let recheck = self.recheck_tx.clone();
        let sig = signature.clone();
        let task = tokio::spawn(async move {
            run_connection(app, url, token, profile_id, using_internal, out_rx, recheck).await;
        });
        *guard = Some(ConnectionHandle {
            signature: sig,
            task,
            out_tx,
        });
    }

    /// Tear down the active connection (e.g. no profiles / shutting down).
    pub async fn disconnect(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(old) = guard.take() {
            old.task.abort();
        }
        let _ = self.app.emit(
            "ha://status",
            ConnectionStatus {
                connected: false,
                profile_id: None,
                url: None,
                using_internal: false,
                kind: "network".into(),
                message: Some("disconnected".into()),
            },
        );
    }

    /// Send a `call_service` over the live connection and await its result.
    pub async fn call_service(
        &self,
        domain: String,
        service: String,
        data: Option<Value>,
        target: Option<Value>,
    ) -> Result<Value, String> {
        let mut payload = json!({ "type": "call_service", "domain": domain, "service": service });
        if let Some(d) = data {
            payload["service_data"] = d;
        }
        if let Some(t) = target {
            payload["target"] = t;
        }
        self.request(payload).await
    }

    /// Send an arbitrary WS command (the `type` must already be set on the
    /// payload; the id is assigned by the connection task) and await its result.
    pub async fn request(&self, payload: Value) -> Result<Value, String> {
        let out_tx = {
            let guard = self.inner.lock().await;
            guard.as_ref().map(|h| h.out_tx.clone())
        }
        .ok_or_else(|| "not connected".to_string())?;

        let (tx, rx) = oneshot::channel();
        out_tx
            .send(Outgoing {
                payload,
                responder: tx,
            })
            .await
            .map_err(|_| "connection closed".to_string())?;

        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("connection dropped before reply".into()),
            Err(_) => Err("timed out waiting for Home Assistant".into()),
        }
    }
}

async fn run_connection(
    app: AppHandle,
    url: String,
    token: String,
    profile_id: String,
    using_internal: bool,
    mut out_rx: mpsc::Receiver<Outgoing>,
    recheck_tx: mpsc::UnboundedSender<()>,
) {
    let mut backoff_ms: u64 = 1000;
    loop {
        emit_status(
            &app,
            &profile_id,
            &url,
            using_internal,
            "connecting",
            None,
            false,
        );

        match connect_once(&app, &url, &token, &profile_id, using_internal, &mut out_rx).await {
            ConnResult::AuthFailed(msg) => {
                emit_status(
                    &app,
                    &profile_id,
                    &url,
                    using_internal,
                    "auth",
                    Some(msg),
                    false,
                );
                // A token problem is not a network problem — stop here instead of
                // hammering reconnects. The user must fix the token.
                return;
            }
            ConnResult::Disconnected(reason) => {
                emit_status(
                    &app,
                    &profile_id,
                    &url,
                    using_internal,
                    "network",
                    Some(reason),
                    false,
                );
                // Cleanest "I left the house" signal: ask the app to re-evaluate
                // which profile/URL we should be using.
                let _ = recheck_tx.send(());
            }
        }

        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(15_000);
    }
}

async fn connect_once(
    app: &AppHandle,
    base_url: &str,
    token: &str,
    profile_id: &str,
    using_internal: bool,
    out_rx: &mut mpsc::Receiver<Outgoing>,
) -> ConnResult {
    let ws_url = match to_ws_url(base_url) {
        Some(u) => u,
        None => return ConnResult::Disconnected(format!("invalid URL: {base_url}")),
    };

    let (stream, _) = match tokio_tungstenite::connect_async(&ws_url).await {
        Ok(s) => s,
        Err(e) => return ConnResult::Disconnected(format!("connect failed: {e}")),
    };
    let (mut write, mut read) = stream.split();

    // --- 1. wait for auth_required ---
    if let Err(reason) = read_until_type(&mut read, "auth_required").await {
        return ConnResult::Disconnected(reason);
    }

    // --- 2. authenticate ---
    let auth = json!({ "type": "auth", "access_token": token }).to_string();
    if write.send(Message::Text(auth)).await.is_err() {
        return ConnResult::Disconnected("failed to send auth".into());
    }
    loop {
        match read.next().await {
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t.to_string()).unwrap_or(Value::Null);
                match v["type"].as_str() {
                    Some("auth_ok") => break,
                    Some("auth_invalid") => {
                        let m = v["message"]
                            .as_str()
                            .unwrap_or("invalid access token")
                            .to_string();
                        return ConnResult::AuthFailed(m);
                    }
                    _ => continue,
                }
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => return ConnResult::Disconnected(format!("read error: {e}")),
            None => return ConnResult::Disconnected("closed during auth".into()),
        }
    }

    // --- 3. subscribe BEFORE get_states (avoid missed-event race) ---
    let mut next_id: u64 = 1;
    let sub_id = take_id(&mut next_id);
    let sub = json!({ "id": sub_id, "type": "subscribe_events", "event_type": "state_changed" })
        .to_string();
    if write.send(Message::Text(sub)).await.is_err() {
        return ConnResult::Disconnected("failed to subscribe".into());
    }

    // --- 4. request the initial snapshot ---
    let states_id = take_id(&mut next_id);
    let get_states = json!({ "id": states_id, "type": "get_states" }).to_string();
    if write.send(Message::Text(get_states)).await.is_err() {
        return ConnResult::Disconnected("failed to request states".into());
    }

    emit_status(app, profile_id, base_url, using_internal, "ok", None, true);

    // --- 5. main loop ---
    let mut pending: HashMap<u64, oneshot::Sender<Result<Value, String>>> = HashMap::new();
    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await; // discard the immediate first tick

    loop {
        tokio::select! {
            biased;

            cmd = out_rx.recv() => match cmd {
                Some(Outgoing { mut payload, responder }) => {
                    let id = take_id(&mut next_id);
                    payload["id"] = json!(id);
                    if write.send(Message::Text(payload.to_string())).await.is_err() {
                        let _ = responder.send(Err("failed to send command".into()));
                        return ConnResult::Disconnected("send failed".into());
                    }
                    pending.insert(id, responder);
                }
                None => return ConnResult::Disconnected("command channel closed".into()),
            },

            _ = ping.tick() => {
                let id = take_id(&mut next_id);
                let ping_msg = json!({ "id": id, "type": "ping" }).to_string();
                if write.send(Message::Text(ping_msg)).await.is_err() {
                    return ConnResult::Disconnected("ping failed".into());
                }
            }

            incoming = read.next() => match incoming {
                Some(Ok(Message::Text(t))) => handle_message(app, &t.to_string(), states_id, &mut pending),
                Some(Ok(Message::Ping(p))) => { let _ = write.send(Message::Pong(p)).await; }
                Some(Ok(Message::Close(_))) => return ConnResult::Disconnected("server closed connection".into()),
                Some(Ok(_)) => {}
                Some(Err(e)) => return ConnResult::Disconnected(format!("read error: {e}")),
                None => return ConnResult::Disconnected("stream ended".into()),
            },
        }
    }
}

/// Read text frames until one with the given `type`, ignoring others.
async fn read_until_type<S>(read: &mut S, want: &str) -> Result<(), String>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match read.next().await {
            Some(Ok(Message::Text(t))) => {
                let v: Value = serde_json::from_str(&t.to_string()).unwrap_or(Value::Null);
                if v["type"].as_str() == Some(want) {
                    return Ok(());
                }
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(format!("read error: {e}")),
            None => return Err("connection closed during handshake".into()),
        }
    }
}

fn handle_message(
    app: &AppHandle,
    text: &str,
    states_id: u64,
    pending: &mut HashMap<u64, oneshot::Sender<Result<Value, String>>>,
) {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    match v["type"].as_str() {
        Some("event") => {
            let new_state = &v["event"]["data"]["new_state"];
            if let Some(state) = parse_state(new_state) {
                let _ = app.emit("ha://state", state);
            }
        }
        Some("result") => {
            let id = v["id"].as_u64().unwrap_or(0);
            if id == states_id {
                if let Some(arr) = v["result"].as_array() {
                    let states: Vec<EntityState> = arr.iter().filter_map(parse_state).collect();
                    let _ = app.emit("ha://states", states);
                }
            } else if let Some(responder) = pending.remove(&id) {
                if v["success"].as_bool().unwrap_or(false) {
                    let _ = responder.send(Ok(v["result"].clone()));
                } else {
                    let msg = v["error"]["message"]
                        .as_str()
                        .unwrap_or("call failed")
                        .to_string();
                    let _ = responder.send(Err(msg));
                }
            }
        }
        _ => {}
    }
}

fn parse_state(v: &Value) -> Option<EntityState> {
    let entity_id = v["entity_id"].as_str()?.to_string();
    let state = v["state"].as_str().unwrap_or("unknown").to_string();
    let attributes = v
        .get("attributes")
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    Some(EntityState {
        entity_id,
        state,
        attributes,
    })
}

fn take_id(next_id: &mut u64) -> u64 {
    let id = *next_id;
    *next_id += 1;
    id
}

fn to_ws_url(base: &str) -> Option<String> {
    let base = base.trim().trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return None;
    };
    Some(format!("{ws}/api/websocket"))
}

#[allow(clippy::too_many_arguments)]
fn emit_status(
    app: &AppHandle,
    profile_id: &str,
    url: &str,
    using_internal: bool,
    kind: &str,
    message: Option<String>,
    connected: bool,
) {
    let _ = app.emit(
        "ha://status",
        ConnectionStatus {
            connected,
            profile_id: Some(profile_id.to_string()),
            url: Some(url.to_string()),
            using_internal,
            kind: kind.to_string(),
            message,
        },
    );
}

/// Result of the SEPARATE authenticated token check (used by onboarding/config).
/// Kept distinct from the unauthenticated reachability probe so a bad token can
/// never be misread as an unreachable network.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "result")]
pub enum TokenCheck {
    Valid,
    Unauthorized,
    Unreachable { message: String },
}

/// Authenticated check: does `token` work against `base_url`? Uses a strict TLS
/// stack (unlike the lenient reachability probe).
pub async fn validate_token(base_url: &str, token: &str) -> TokenCheck {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return TokenCheck::Unreachable {
                message: e.to_string(),
            }
        }
    };
    let url = format!("{}/api/", base_url.trim_end_matches('/'));
    match client.get(&url).bearer_auth(token).send().await {
        Ok(resp) => {
            let code = resp.status().as_u16();
            if resp.status().is_success() {
                TokenCheck::Valid
            } else if code == 401 || code == 403 {
                TokenCheck::Unauthorized
            } else {
                TokenCheck::Unreachable {
                    message: format!("unexpected status {code}"),
                }
            }
        }
        Err(e) => TokenCheck::Unreachable {
            message: e.to_string(),
        },
    }
}

/// Fetch HA Areas (rooms) and each entity's resolved area over the live socket.
///
/// Joins the area, device, and entity registries: an entity's area is its own
/// `area_id`, falling back to its device's `area_id`. Disabled/hidden entities
/// are skipped. Any failure (e.g. a non-admin token can't read these registries)
/// returns an empty result, so the grid degrades to an "Unassigned" section
/// rather than breaking.
pub async fn fetch_areas(manager: &HaManager) -> AreasResult {
    let areas_raw = match manager
        .request(json!({ "type": "config/area_registry/list" }))
        .await
    {
        Ok(v) => v,
        Err(_) => return AreasResult::default(),
    };
    let devices_raw = match manager
        .request(json!({ "type": "config/device_registry/list" }))
        .await
    {
        Ok(v) => v,
        Err(_) => return AreasResult::default(),
    };
    let entities_raw = match manager
        .request(json!({ "type": "config/entity_registry/list" }))
        .await
    {
        Ok(v) => v,
        Err(_) => return AreasResult::default(),
    };

    let mut areas = Vec::new();
    if let Some(arr) = areas_raw.as_array() {
        for a in arr {
            if let Some(id) = a["area_id"].as_str() {
                let name = a["name"].as_str().unwrap_or(id).to_string();
                areas.push(AreaInfo {
                    id: id.to_string(),
                    name,
                });
            }
        }
    }

    // device id -> area id
    let mut device_area: HashMap<String, String> = HashMap::new();
    if let Some(arr) = devices_raw.as_array() {
        for d in arr {
            if let (Some(id), Some(area)) = (d["id"].as_str(), d["area_id"].as_str()) {
                device_area.insert(id.to_string(), area.to_string());
            }
        }
    }

    let mut entity_areas = Vec::new();
    let mut entity_meta = Vec::new();
    if let Some(arr) = entities_raw.as_array() {
        for e in arr {
            let Some(entity_id) = e["entity_id"].as_str() else {
                continue;
            };
            // Record metadata for filtering (config/diagnostic sub-entities and
            // user-hidden entities are excluded from the grid by default).
            entity_meta.push(EntityMeta {
                entity_id: entity_id.to_string(),
                category: e["entity_category"].as_str().unwrap_or("").to_string(),
                hidden: !e["hidden_by"].is_null(),
            });

            // Disabled entities aren't loaded by HA, so they won't be in states;
            // only resolve areas for the rest.
            if !e["disabled_by"].is_null() {
                continue;
            }
            let area = e["area_id"].as_str().map(|s| s.to_string()).or_else(|| {
                e["device_id"]
                    .as_str()
                    .and_then(|d| device_area.get(d).cloned())
            });
            if let Some(area_id) = area {
                entity_areas.push(EntityArea {
                    entity_id: entity_id.to_string(),
                    area_id,
                });
            }
        }
    }

    AreasResult {
        areas,
        entity_areas,
        entity_meta,
    }
}
