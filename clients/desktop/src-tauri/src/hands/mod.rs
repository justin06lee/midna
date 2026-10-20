//! midna's hands on this computer.
//!
//! The app offers midna what Justin turns on here — each capability Off, Ask
//! or On — and nothing while paused. The app holds the OS permissions, so
//! they are granted once, to midna.app. Whatever midna does here shows in the
//! tray, in the window and, while it looks at or works the screen, in a pill
//! at the top of the display, kept out of its own screenshots. The last 200
//! commands are kept here too, readable even when the host isn't.
//! (docs/device-hands.md is the design.)

pub mod conn;
#[cfg(target_os = "macos")]
mod mac;

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// packages/protocol's HANDS_PROTOCOL.
pub const HANDS_PROTOCOL: u32 = 1;
/// Everything a device may offer, in the design's order.
pub const CAPABILITIES: [&str; 8] = ["screen", "input", "script", "shell", "files", "clipboard", "open", "notify"];
/// What this version can do; the rest wait on decisions.
pub const AVAILABLE: [&str; 3] = ["screen", "open", "notify"];
const KEEP: usize = 200;
/// The indicator stays this long after a command, so a quick one is still seen.
const LINGER: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    #[default]
    Off,
    Ask,
    On,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionState {
    Granted,
    NotGranted,
    NotAsked,
    /// Automation: the app isn't running, so macOS can't say.
    NotRunning,
    Unknown,
    /// Not a thing on this OS.
    NotApplicable,
}

#[derive(Clone, Debug, Serialize)]
pub struct Display {
    pub id: String,
    pub name: String,
    pub primary: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// What Justin chose here; kept in the app's config folder.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Config {
    /// Only the toggles he has touched.
    #[serde(default)]
    pub offers: BTreeMap<String, Policy>,
    /// What an untouched toggle is: packages/protocol's HANDS_POLICY.defaults, handed over by the web view at every launch.
    #[serde(default)]
    pub defaults: BTreeMap<String, Policy>,
    #[serde(default)]
    pub paused: bool,
}

impl Config {
    /// A capability's toggle: his choice, else the policy table's, else off.
    pub fn toggle(&self, capability: &str) -> Policy {
        self.offers.get(capability).or(self.defaults.get(capability)).copied().unwrap_or_default()
    }
}

/// One command midna sent, as it went.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub op: String,
    pub summary: String,
    pub at: u64,
    pub ms: u64,
    /// "ok", or why not: "off", "paused", "locked", "permission", "failed", …
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Default)]
pub struct Hands {
    pub config: Config,
    pub recent: VecDeque<Entry>,
    /// What midna is doing here right now, said plainly.
    pub active: Option<String>,
    /// Bumped with every command, so a lingering indicator knows it has been overtaken.
    generation: u64,
    /// Whether midna's daemon holds a live connection to this device.
    pub connected: bool,
    /// Something Justin should know about the connection (a host key that changed).
    pub problem: Option<String>,
}

pub type Shared = Mutex<Hands>;

/// Why a command didn't run.
#[derive(Debug, Clone, Serialize)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
    /// The permission that's missing, when that's why.
    pub permission: Option<&'static str>,
}

impl Refusal {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Refusal { code, message: message.into(), permission: None }
    }
}

/// What a command produced: JSON for midna, and a file to upload alongside (a screenshot).
pub struct Outcome {
    pub data: Value,
    pub file: Option<(String, Vec<u8>)>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir())
}

fn load<T: for<'de> Deserialize<'de> + Default>(app: &AppHandle, name: &str) -> T {
    std::fs::read(dir(app).join(name)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save<T: Serialize>(app: &AppHandle, name: &str, value: &T) {
    let d = dir(app);
    let _ = std::fs::create_dir_all(&d);
    if let Ok(bytes) = serde_json::to_vec_pretty(value) {
        let tmp = d.join(format!("{name}.part"));
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(tmp, d.join(name));
        }
    }
}

/// Read the choices and the log back at launch. A pause survives a restart.
pub fn init(app: &AppHandle) -> Shared {
    let recent: Vec<Entry> = load(app, "hands-log.json");
    Mutex::new(Hands { config: load(app, "hands.json"), recent: recent.into_iter().rev().take(KEEP).rev().collect(), ..Default::default() })
}

// ── what the app reports ─────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Permission {
    pub id: &'static str,
    pub state: PermissionState,
}

pub fn permissions() -> Vec<Permission> {
    #[cfg(target_os = "macos")]
    {
        vec![
            Permission { id: "screen_recording", state: mac::screen_recording() },
            Permission { id: "accessibility", state: mac::accessibility() },
            Permission { id: "automation:com.apple.MobileSMS", state: mac::automation("com.apple.MobileSMS", false) },
            Permission { id: "automation:com.apple.systemevents", state: mac::automation("com.apple.systemevents", false) },
            Permission { id: "full_disk_access", state: mac::full_disk_access() },
            Permission { id: "notifications", state: mac::notifications() },
        ]
    }
    #[cfg(not(target_os = "macos"))]
    {
        vec![]
    }
}

pub fn displays() -> Vec<Display> {
    #[cfg(target_os = "macos")]
    return mac::displays();
    #[cfg(not(target_os = "macos"))]
    return vec![];
}

/// "ready", "paused", "locked" or "display_asleep".
pub fn state(h: &Hands) -> &'static str {
    if h.config.paused {
        return "paused";
    }
    #[cfg(target_os = "macos")]
    {
        if mac::locked() {
            return "locked";
        }
        if mac::display_asleep() {
            return "display_asleep";
        }
    }
    "ready"
}

/// The permission a capability can't work without, here.
fn needs(capability: &str) -> Option<&'static str> {
    match capability {
        "screen" => Some("screen_recording"),
        "notify" => Some("notifications"),
        _ => None,
    }
}

fn permission(id: &str) -> PermissionState {
    #[cfg(target_os = "macos")]
    return match id {
        "screen_recording" => mac::screen_recording(),
        "notifications" => mac::notifications(),
        _ => PermissionState::Unknown,
    };
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        PermissionState::NotApplicable
    }
}

/// What this device offers midna: available capabilities that are on or ask.
pub fn offers(h: &Hands) -> BTreeMap<String, Policy> {
    AVAILABLE
        .iter()
        .filter_map(|c| match h.config.toggle(c) {
            Policy::Off => None,
            p => Some((c.to_string(), p)),
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    platform: &'static str,
    capabilities: Vec<Value>,
    paused: bool,
    state: &'static str,
    connected: bool,
    problem: Option<String>,
    active: Option<String>,
    permissions: Vec<Permission>,
    displays: Vec<Display>,
    recent: Vec<Entry>,
}

/// Async, so the permission checks (a notification-settings query can take a moment) stay off the main thread.
#[tauri::command]
pub async fn hands_status(app: AppHandle) -> Status {
    let shared = app.state::<Shared>();
    let h = shared.lock().unwrap();
    Status {
        platform: std::env::consts::OS,
        capabilities: CAPABILITIES
            .iter()
            .map(|c| json!({ "id": c, "available": AVAILABLE.contains(c), "policy": h.config.toggle(c), "needs": needs(c) }))
            .collect(),
        paused: h.config.paused,
        state: state(&h),
        connected: h.connected,
        problem: h.problem.clone(),
        active: h.active.clone(),
        permissions: permissions(),
        displays: displays(),
        recent: h.recent.iter().rev().cloned().collect(),
    }
}

#[tauri::command]
pub fn hands_set_offer(app: AppHandle, capability: String, policy: Policy) -> Result<(), String> {
    if !AVAILABLE.contains(&capability.as_str()) {
        return Err(format!("{capability} isn't something this version can offer yet"));
    }
    {
        let shared = app.state::<Shared>();
        let mut h = shared.lock().unwrap();
        h.config.offers.insert(capability, policy);
        save(&app, "hands.json", &h.config);
    }
    changed(&app);
    Ok(())
}

/// The policy table's defaults, from packages/protocol, so the app never keeps its own.
#[tauri::command]
pub fn hands_defaults(app: AppHandle, defaults: BTreeMap<String, Policy>) {
    {
        let shared = app.state::<Shared>();
        let mut h = shared.lock().unwrap();
        if h.config.defaults == defaults {
            return;
        }
        h.config.defaults = defaults;
        save(&app, "hands.json", &h.config);
    }
    changed(&app);
}

#[tauri::command]
pub fn hands_set_paused(app: AppHandle, paused: bool) {
    set_paused(&app, paused);
}

pub fn set_paused(app: &AppHandle, paused: bool) {
    {
        let shared = app.state::<Shared>();
        let mut h = shared.lock().unwrap();
        h.config.paused = paused;
        if paused {
            h.active = None;
        }
        save(app, "hands.json", &h.config);
    }
    changed(app);
}

pub fn toggle_pause(app: &AppHandle) {
    let paused = app.state::<Shared>().lock().unwrap().config.paused;
    set_paused(app, !paused);
}

#[tauri::command]
pub async fn permission_request(id: String) {
    #[cfg(target_os = "macos")]
    match id.as_str() {
        "screen_recording" => mac::request_screen_recording(),
        "accessibility" => mac::request_accessibility(),
        "notifications" => mac::request_notifications(),
        _ => {
            if let Some(bundle) = id.strip_prefix("automation:") {
                if mac::automation(bundle, false) == PermissionState::NotRunning {
                    mac::launch_hidden(bundle);
                    std::thread::sleep(Duration::from_millis(800));
                }
                mac::automation(bundle, true);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = id;
}

#[tauri::command]
pub fn permission_open(id: String) {
    #[cfg(target_os = "macos")]
    mac::open_settings(id.split(':').next().unwrap_or(""));
    #[cfg(not(target_os = "macos"))]
    let _ = id;
}

/// Quit and start again: Screen Recording takes effect only in a new process.
#[tauri::command]
pub fn relaunch(app: AppHandle) {
    app.restart();
}

// ── running a command ────────────────────────────────────────────────────

/// Run one of midna's commands here: refused when paused, off, locked or
/// lacking a permission; otherwise done, shown while it runs, and logged.
pub async fn execute(app: &AppHandle, id: &str, op: &str, args: &Value) -> Result<Outcome, Refusal> {
    let started = now_ms();
    let capability = capability_of(op);
    let summary = describe(op, args);
    let checked = {
        let shared = app.state::<Shared>();
        let h = shared.lock().unwrap();
        gate(&h, capability)
    };
    let result = match checked {
        Err(r) => Err(r),
        Ok(()) => {
            begin(app, &summary, capability == "screen");
            let r = run(app, op, args).await;
            end(app);
            r
        }
    };
    let entry = Entry {
        id: id.to_string(),
        op: op.to_string(),
        summary,
        at: started,
        ms: now_ms().saturating_sub(started),
        outcome: match &result {
            Ok(_) => "ok".into(),
            Err(r) => r.code.into(),
        },
        detail: result.as_ref().err().map(|r| r.message.clone()),
    };
    {
        let shared = app.state::<Shared>();
        let mut h = shared.lock().unwrap();
        h.recent.push_back(entry);
        while h.recent.len() > KEEP {
            h.recent.pop_front();
        }
        save(app, "hands-log.json", &h.recent);
    }
    changed(app);
    result
}

fn capability_of(op: &str) -> &'static str {
    match op {
        "screenshot" => "screen",
        "open" => "open",
        "notify" => "notify",
        _ => "unknown",
    }
}

fn gate(h: &Hands, capability: &str) -> Result<(), Refusal> {
    if h.config.paused {
        return Err(Refusal::new("paused", "Justin has paused midna's hands on this computer"));
    }
    if !AVAILABLE.contains(&capability) {
        return Err(Refusal::new("unsupported", "this computer can't do that yet"));
    }
    if h.config.toggle(capability) == Policy::Off {
        return Err(Refusal::new("off", format!("{capability} is turned off on this computer")));
    }
    let s = state(h);
    if capability == "screen" && (s == "locked" || s == "display_asleep") {
        return Err(Refusal::new("locked", if s == "locked" { "the screen is locked" } else { "the display is asleep" }));
    }
    if let Some(p) = needs(capability) {
        let st = permission(p);
        if st != PermissionState::Granted && st != PermissionState::Unknown && st != PermissionState::NotApplicable {
            return Err(Refusal { permission: Some(p), ..Refusal::new("permission", format!("midna.app hasn't been given {}", p.replace('_', " "))) });
        }
    }
    Ok(())
}

fn describe(op: &str, args: &Value) -> String {
    match op {
        "screenshot" => "taking a screenshot".into(),
        "open" => format!("opening {}", args.get("url").or(args.get("app")).or(args.get("path")).and_then(Value::as_str).unwrap_or("something")),
        "notify" => "showing a notification".into(),
        other => other.to_string(),
    }
}

async fn run(app: &AppHandle, op: &str, args: &Value) -> Result<Outcome, Refusal> {
    let failed = |e: String| Refusal::new("failed", e);
    match op {
        "screenshot" => {
            let app = app.clone();
            let args = args.clone();
            tauri::async_runtime::spawn_blocking(move || screenshot(&app, &args)).await.map_err(|e| failed(e.to_string()))?
        }
        "open" => {
            let target = ["url", "app", "path"].iter().find_map(|k| args.get(*k).and_then(Value::as_str).map(|v| (*k, v.to_string())));
            let Some((kind, value)) = target else { return Err(Refusal::new("bad_args", "open needs a url, an app or a path")) };
            let mut cmd = std::process::Command::new(if cfg!(target_os = "macos") { "/usr/bin/open" } else { "xdg-open" });
            if kind == "app" && cfg!(target_os = "macos") {
                cmd.arg("-a");
            }
            let status = cmd.arg(&value).status().map_err(|e| failed(e.to_string()))?;
            if !status.success() {
                return Err(failed(format!("couldn't open {value}")));
            }
            Ok(Outcome { data: json!({}), file: None })
        }
        "notify" => {
            use tauri_plugin_notification::NotificationExt;
            let title = args.get("title").and_then(Value::as_str).unwrap_or("midna");
            let body = args.get("body").and_then(Value::as_str).unwrap_or("");
            app.notification().builder().title(title).body(body).show().map_err(|e| failed(e.to_string()))?;
            Ok(Outcome { data: json!({}), file: None })
        }
        _ => Err(Refusal::new("unsupported", format!("this computer doesn't know {op}"))),
    }
}

/// A display as a PNG, its long edge at most 1568 px unless `full` — the size models read best.
fn screenshot(app: &AppHandle, args: &Value) -> Result<Outcome, Refusal> {
    #[cfg(target_os = "macos")]
    {
        let all = displays();
        let display = match args.get("display").and_then(Value::as_str) {
            Some(d) => all.iter().find(|x| x.id == d).cloned().ok_or_else(|| Refusal::new("bad_args", format!("there's no display {d}")))?,
            None => all.iter().find(|x| x.primary).or(all.first()).cloned().ok_or_else(|| Refusal::new("failed", "no display"))?,
        };
        let full = args.get("full").and_then(Value::as_bool).unwrap_or(false);
        let tmp = std::env::temp_dir().join(format!("midna-shot-{}.png", now_ms()));
        let _ = app;
        mac::screenshot(&display.id, if full { None } else { Some(1568) }, &tmp).map_err(|e| Refusal::new("failed", e))?;
        let bytes = std::fs::read(&tmp).map_err(|e| Refusal::new("failed", e.to_string()))?;
        let _ = std::fs::remove_file(&tmp);
        let (width, height) = mac::png_size(&bytes);
        let (cx, cy) = mac::cursor();
        // The pointer in this picture's pixels, when it's on this display.
        let sx = width as f64 / display.width;
        let inside = cx >= display.x && cx < display.x + display.width && cy >= display.y && cy < display.y + display.height;
        let cursor = if inside { json!({ "x": ((cx - display.x) * sx).round(), "y": ((cy - display.y) * sx).round() }) } else { Value::Null };
        Ok(Outcome {
            data: json!({ "display": display.id, "width": width, "height": height, "scale": sx, "cursor": cursor }),
            file: Some((format!("screenshot-{}-{}.png", display.id, now_ms()), bytes)),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, args);
        Err(Refusal::new("unsupported", "screenshots come to Linux later"))
    }
}

// ── showing it ───────────────────────────────────────────────────────────

fn begin(app: &AppHandle, summary: &str, on_screen: bool) {
    {
        let shared = app.state::<Shared>();
        let mut h = shared.lock().unwrap();
        h.generation += 1;
        h.active = Some(summary.to_string());
    }
    if on_screen {
        show_pill(app);
    }
    changed(app);
}

fn end(app: &AppHandle) {
    let generation = app.state::<Shared>().lock().unwrap().generation;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LINGER).await;
        {
            let shared = app.state::<Shared>();
            let mut h = shared.lock().unwrap();
            if h.generation != generation {
                return; // another command took over the indicator
            }
            h.active = None;
        }
        if let Some(pill) = app.get_webview_window("pill") {
            let _ = pill.hide();
        }
        changed(&app);
    });
}

/// Tell the windows and the daemon, and redraw the tray.
pub fn changed(app: &AppHandle) {
    let _ = app.emit("hands", ());
    if let Some(poke) = app.try_state::<conn::Poke>() {
        poke.0.notify_one();
    }
    refresh_tray(app);
    let (paused, active) = {
        let h = app.state::<Shared>();
        let h = h.lock().unwrap();
        (h.config.paused, h.active.is_some())
    };
    if paused || !active {
        if let Some(pill) = app.get_webview_window("pill") {
            let _ = pill.hide();
        }
    }
}

pub fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let (paused, active) = {
        let h = app.state::<Shared>();
        let h = h.lock().unwrap();
        (h.config.paused, h.active.clone())
    };
    let open = MenuItem::with_id(app, "open", "Open midna", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", if paused { "Resume midna's hands" } else { "Pause midna's hands" }, true, Some("Ctrl+Alt+Super+P"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit midna", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    match active {
        Some(what) => {
            let doing = MenuItem::with_id(app, "doing", format!("midna is using this computer: {what}"), false, None::<&str>)?;
            Menu::with_items(app, &[&doing, &pause, &sep, &open, &quit])
        }
        None => Menu::with_items(app, &[&open, &pause, &sep, &quit]),
    }
}

fn refresh_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("midna") else { return };
    let active = app.state::<Shared>().lock().unwrap().active.is_some();
    let icon: &[u8] = if active { include_bytes!("../../icons/tray-active.png") } else { include_bytes!("../../icons/tray.png") };
    if let Ok(img) = Image::from_bytes(icon) {
        let _ = tray.set_icon(Some(img));
        let _ = tray.set_icon_as_template(true);
    }
    let _ = tray.set_tooltip(Some(if active { "midna is using this computer" } else { "midna" }));
    if let Ok(menu) = tray_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// The pill at the top of the main display while midna looks at or works the screen.
fn show_pill(app: &AppHandle) {
    const W: f64 = 340.0;
    const H: f64 = 44.0;
    let pill = match app.get_webview_window("pill") {
        Some(p) => p,
        None => {
            let Ok(p) = WebviewWindowBuilder::new(app, "pill", WebviewUrl::App("index.html#pill".into()))
                .title("midna")
                .inner_size(W, H)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible_on_all_workspaces(true)
                .focused(false)
                .visible(false)
                .build()
            else {
                return;
            };
            #[cfg(target_os = "macos")]
            {
                let handle = p.clone();
                let _ = p.run_on_main_thread(move || {
                    if let Ok(ns) = handle.ns_window() {
                        mac::exclude_from_capture(ns);
                    }
                });
            }
            p
        }
    };
    if let Ok(Some(m)) = app.primary_monitor() {
        let scale = m.scale_factor();
        let size = m.size().to_logical::<f64>(scale);
        let pos = m.position().to_logical::<f64>(scale);
        let _ = pill.set_position(tauri::LogicalPosition::new(pos.x + (size.width - W) / 2.0, pos.y + 40.0));
    }
    let _ = pill.show();
}

// ── what midna hears about this computer ─────────────────────────────────

/// A permission as the protocol says it; None when it can't be known now.
fn wire(state: PermissionState) -> Option<&'static str> {
    match state {
        PermissionState::Granted => Some("granted"),
        PermissionState::NotGranted => Some("denied"),
        PermissionState::NotAsked => Some("not_asked"),
        PermissionState::NotApplicable => Some("n/a"),
        PermissionState::NotRunning | PermissionState::Unknown => None,
    }
}

fn os_version() -> String {
    static V: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    V.get_or_init(|| {
        let out = if cfg!(target_os = "macos") { std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output() } else { std::process::Command::new("uname").arg("-r").output() };
        out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
    })
    .clone()
}

fn hostname() -> String {
    std::process::Command::new("hostname").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}

/// The HandsHello this computer would send now (state updates are cut from it too).
pub fn hello(app: &AppHandle, nonce: &str) -> Value {
    let (offers, state) = {
        let shared = app.state::<Shared>();
        let h = shared.lock().unwrap();
        (offers(&h), state(&h))
    };
    let mut perms = serde_json::Map::new();
    let mut automation = serde_json::Map::new();
    for p in permissions() {
        let Some(w) = wire(p.state) else { continue };
        match p.id.strip_prefix("automation:") {
            Some(bundle) => {
                automation.insert(bundle.to_string(), json!(w));
            }
            None => {
                perms.insert(p.id.to_string(), json!(w));
            }
        }
    }
    // Automation as one permission: granted when every app asked about is.
    if !automation.is_empty() {
        let all = automation.values().all(|v| v == "granted");
        let denied = automation.values().any(|v| v == "denied");
        perms.insert("automation".into(), json!(if all { "granted" } else if denied { "denied" } else { "not_asked" }));
    }
    let mac = cfg!(target_os = "macos");
    json!({
        "protocol": HANDS_PROTOCOL,
        "app": { "version": app.package_info().version.to_string() },
        "os": {
            "family": if mac { "macos" } else { "linux" },
            "version": os_version(),
            "arch": match std::env::consts::ARCH { "aarch64" => "arm64", a => a },
            "hostname": hostname(),
            "session": if mac { "quartz" } else if std::env::var("WAYLAND_DISPLAY").is_ok() { "wayland" } else { "x11" },
        },
        "displays": displays(),
        "offers": offers,
        "permissions": perms,
        "automation": automation,
        "state": state,
        "nonce": nonce,
    })
}
