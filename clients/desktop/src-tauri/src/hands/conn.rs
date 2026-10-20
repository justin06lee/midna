//! The connection to midna's daemon, always outbound: say hello, hold an SSE
//! stream of signed commands, post state changes and results back. Nothing
//! listens on this computer, and a command runs only if it is signed by the
//! daemon's pinned key, over this connection's nonce, with a seq above every
//! one before it and an id never seen. The shapes are packages/protocol's
//! hands.ts; fixtures/hands.json keeps the two in step (the test below).

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

use super::Shared;

/// Pokes the state sync when something changed here.
pub struct Poke(pub Arc<Notify>);

/// What connection.json holds that matters here.
#[derive(Deserialize, Clone)]
struct Connection {
    url: String,
    token: String,
    #[serde(default)]
    device: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Welcome {
    session: String,
    daemon_key: String,
    fingerprint: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum StreamEvent {
    Command { signed: String, sig: String },
    Cancel { id: String },
    Bye { reason: String },
}

/// A command, once its signature checks out.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub nonce: String,
    pub seq: u64,
    pub op: String,
    pub args: Value,
    pub timeout_ms: u64,
    #[serde(default)]
    pub episode_id: Option<i64>,
}

/// Check `sig` over the bytes of `signed` exactly as they came, then read them.
pub fn verify(key: &str, signed: &str, sig: &str) -> Result<Command, String> {
    let key: [u8; 32] = B64.decode(key).map_err(|_| "the daemon's key isn't base64url")?.try_into().map_err(|_| "the daemon's key isn't 32 bytes")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "the daemon's key isn't a valid Ed25519 key")?;
    let sig: [u8; 64] = B64.decode(sig).map_err(|_| "the signature isn't base64url")?.try_into().map_err(|_| "the signature isn't 64 bytes")?;
    key.verify(signed.as_bytes(), &Signature::from_bytes(&sig)).map_err(|_| "the signature doesn't match the daemon's key")?;
    serde_json::from_str(signed).map_err(|e| format!("a signed command that isn't one: {e}"))
}

/// Why a session ended, and how long to wait before the next.
struct Pause(u64);

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().expect("an HTTP client");
        let mut backoff = 1;
        loop {
            let ended = session(&app, &http).await;
            set_connected(&app, false, None);
            let wait = match ended {
                Ok(()) => {
                    backoff = 1;
                    1
                }
                Err(Pause(s)) if s == 0 => {
                    let b = backoff;
                    backoff = (backoff * 2).min(60);
                    b
                }
                Err(Pause(s)) => s,
            };
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    });
}

fn set_connected(app: &AppHandle, connected: bool, problem: Option<String>) {
    {
        let shared = app.state::<Shared>();
        let mut h = shared.lock().unwrap();
        if h.connected == connected && h.problem == problem {
            return;
        }
        h.connected = connected;
        h.problem = problem;
    }
    super::changed(app);
}

fn connection(app: &AppHandle) -> Option<Connection> {
    let file = app.path().app_config_dir().ok()?.join("connection.json");
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

/// The daemon key pinned for a connection: on its first hello, from then on the only one trusted.
fn pinned(app: &AppHandle, conn: &Connection) -> Option<String> {
    let pins: BTreeMap<String, Value> = super::load(app, "hands-keys.json");
    pins.get(&pin_id(conn)).and_then(|v| v.get("key")).and_then(Value::as_str).map(str::to_string)
}

fn pin(app: &AppHandle, conn: &Connection, w: &Welcome) {
    let mut pins: BTreeMap<String, Value> = super::load(app, "hands-keys.json");
    pins.insert(pin_id(conn), json!({ "key": w.daemon_key, "fingerprint": w.fingerprint }));
    super::save(app, "hands-keys.json", &pins);
}

fn pin_id(conn: &Connection) -> String {
    format!("{}#{}", conn.url, conn.device.clone().unwrap_or_default())
}

fn nonce() -> String {
    let mut b = [0u8; 24];
    getrandom::getrandom(&mut b).expect("randomness");
    B64.encode(b)
}

async fn session(app: &AppHandle, http: &reqwest::Client) -> Result<(), Pause> {
    let Some(conn) = connection(app) else { return Err(Pause(5)) };
    let auth = format!("Bearer {}", conn.token);
    let nonce = nonce();
    let hello = super::hello(app, &nonce);
    let r = http.post(format!("{}/v1/hands/hello", conn.url)).header("authorization", &auth).json(&hello).send().await.map_err(|_| Pause(0))?;
    match r.status().as_u16() {
        200 => {}
        // A host from before 0.8 has no hands; ask again now and then, in case it was updated.
        404 => return Err(Pause(300)),
        401 => return Err(Pause(60)),
        _ => return Err(Pause(0)),
    }
    let welcome: Welcome = r.json().await.map_err(|_| Pause(0))?;
    match pinned(app, &conn) {
        None => pin(app, &conn, &welcome),
        Some(k) if k == welcome.daemon_key => {}
        Some(_) => {
            set_connected(app, false, Some(format!("midna's host has a different key ({}) from the one this computer trusts, so its commands aren't accepted.", welcome.fingerprint)));
            return Err(Pause(300));
        }
    }
    let key = welcome.daemon_key.clone();
    let session = welcome.session.clone();

    let stream = http
        .get(format!("{}/v1/hands/stream", conn.url))
        .query(&[("session", &session)])
        .header("authorization", &auth)
        .header("accept", "text/event-stream")
        .send()
        .await
        .map_err(|_| Pause(0))?;
    if !stream.status().is_success() {
        return Err(Pause(0));
    }
    set_connected(app, true, None);

    // Changes here — a toggle, a pause, a permission, a display — go to the daemon as they happen.
    let sync = tauri::async_runtime::spawn(sync_state(app.clone(), http.clone(), conn.clone(), session.clone(), hello));

    let mut bytes = stream.bytes_stream();
    let mut buf = String::new();
    let mut last_seq = 0u64;
    let mut seen: HashSet<String> = HashSet::new();
    let ended = 'read: loop {
        // The daemon writes a keepalive every 25 s; a minute of nothing is a dead connection.
        let chunk = match tokio::time::timeout(Duration::from_secs(60), bytes.next()).await {
            Ok(Some(Ok(c))) => c,
            _ => break 'read Err(Pause(0)),
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = buf.find("\n\n") {
            let block: String = buf.drain(..end + 2).collect();
            let data: Vec<&str> = block.lines().filter_map(|l| l.strip_prefix("data:")).map(|l| l.strip_prefix(' ').unwrap_or(l)).collect();
            if data.is_empty() {
                continue; // a keepalive comment
            }
            match serde_json::from_str::<StreamEvent>(&data.join("\n")) {
                Ok(StreamEvent::Command { signed, sig }) => match verify(&key, &signed, &sig) {
                    Ok(cmd) if cmd.nonce != nonce => eprintln!("hands: refused {}: signed for another connection", cmd.id),
                    Ok(cmd) if cmd.seq <= last_seq => eprintln!("hands: refused {}: seq {} isn't above {}", cmd.id, cmd.seq, last_seq),
                    Ok(cmd) if !seen.insert(cmd.id.clone()) => eprintln!("hands: refused {}: already run", cmd.id),
                    Ok(cmd) => {
                        last_seq = cmd.seq;
                        tauri::async_runtime::spawn(run(app.clone(), http.clone(), conn.clone(), cmd));
                    }
                    Err(e) => eprintln!("hands: refused a command: {e}"),
                },
                // This phase's operations finish in seconds; a cancel arrives after them.
                Ok(StreamEvent::Cancel { id }) => eprintln!("hands: cancel for {id}"),
                Ok(StreamEvent::Bye { reason }) => break 'read if reason == "revoked" { Err(Pause(600)) } else { Ok(()) },
                Err(e) => eprintln!("hands: an event it doesn't know: {e}"),
            }
        }
    };
    sync.abort();
    ended
}

/// Run one command and post its result, uploading any file first.
async fn run(app: AppHandle, http: reqwest::Client, conn: Connection, cmd: Command) {
    let auth = format!("Bearer {}", conn.token);
    let started = std::time::Instant::now();
    let outcome = match tokio::time::timeout(Duration::from_millis(cmd.timeout_ms), super::execute(&app, &cmd.id, &cmd.op, &cmd.args)).await {
        Ok(r) => r,
        Err(_) => Err(super::Refusal::new("timeout", format!("didn't finish within {} ms", cmd.timeout_ms))),
    };
    let result = match outcome {
        Ok(out) => {
            let mut attachments = vec![];
            if let Some((name, bytes)) = out.file {
                let up = http
                    .post(format!("{}/v1/attachments", conn.url))
                    .query(&[("name", name.as_str())])
                    .header("authorization", &auth)
                    .header("content-type", "image/png")
                    .body(bytes)
                    .send()
                    .await;
                match up {
                    Ok(r) if r.status().is_success() => {
                        if let Ok(v) = r.json::<Value>().await {
                            if let Some(id) = v.get("id").and_then(Value::as_str) {
                                attachments.push(id.to_string());
                            }
                        }
                    }
                    _ => {}
                }
                if attachments.is_empty() {
                    let ms = started.elapsed().as_millis() as u64;
                    post_result(&http, &conn, &cmd.id, json!({ "id": cmd.id, "ok": false, "ms": ms, "error": { "code": "failed", "message": "couldn't upload the picture" } })).await;
                    return;
                }
            }
            json!({ "id": cmd.id, "ok": true, "data": out.data, "attachments": attachments, "ms": started.elapsed().as_millis() as u64 })
        }
        Err(r) => {
            let mut error = json!({ "code": r.code, "message": r.message });
            if let Some(p) = r.permission {
                error["permission"] = json!(p);
            }
            json!({ "id": cmd.id, "ok": false, "ms": started.elapsed().as_millis() as u64, "error": error })
        }
    };
    post_result(&http, &conn, &cmd.id, result).await;
}

async fn post_result(http: &reqwest::Client, conn: &Connection, id: &str, result: Value) {
    for attempt in 0..3 {
        let sent = http.post(format!("{}/v1/hands/results/{id}", conn.url)).header("authorization", format!("Bearer {}", conn.token)).json(&result).send().await;
        if matches!(&sent, Ok(r) if r.status().is_success() || r.status().is_client_error()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500 << attempt)).await;
    }
}

/// Post what changed since the hello, whenever something does (and every few seconds, for permissions granted elsewhere).
async fn sync_state(app: AppHandle, http: reqwest::Client, conn: Connection, session: String, hello: Value) {
    let poke = app.state::<Poke>().0.clone();
    let fields = ["state", "offers", "permissions", "automation", "displays"];
    let mut last: BTreeMap<&str, Value> = fields.iter().map(|f| (*f, hello.get(*f).cloned().unwrap_or(Value::Null))).collect();
    loop {
        tokio::select! {
            _ = poke.notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
        }
        let now = super::hello(&app, "");
        let mut update = json!({ "session": session });
        for f in fields {
            let v = now.get(f).cloned().unwrap_or(Value::Null);
            if last.get(f) != Some(&v) {
                update[f] = v.clone();
                last.insert(f, v);
            }
        }
        if update.as_object().map(|o| o.len() > 1).unwrap_or(false) {
            let _ = http.post(format!("{}/v1/hands/state", conn.url)).header("authorization", format!("Bearer {}", conn.token)).json(&update).send().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../../../packages/protocol/fixtures/hands.json")).unwrap()
    }

    #[test]
    fn checks_commands_against_the_daemon_key() {
        let f = fixture();
        let key = f["daemonKey"].as_str().unwrap();
        let ev = &f["events"]["command"];
        let cmd = verify(key, ev["signed"].as_str().unwrap(), ev["sig"].as_str().unwrap()).expect("the fixture's command verifies");
        assert_eq!(cmd.id, "cmd_fixture1");
        assert_eq!(cmd.op, "screenshot");
        assert_eq!(cmd.seq, 1);
        assert_eq!(cmd.args["display"], "1");
        let bad = &f["events"]["tampered"];
        assert!(verify(key, bad["signed"].as_str().unwrap(), bad["sig"].as_str().unwrap()).is_err(), "a tampered command is refused");
    }

    #[test]
    fn reads_every_stream_event() {
        let f = fixture();
        for (name, ev) in f["events"].as_object().unwrap() {
            serde_json::from_value::<StreamEvent>(ev.clone()).unwrap_or_else(|e| panic!("event {name}: {e}"));
        }
    }
}
