//! midna's notifications on this computer: what it says in the chat and its
//! alerts, as system notifications with their sound, a Dock badge counting
//! what came while the window wasn't being looked at, and a click that opens
//! the chat.
//!
//! They come from here, not from the window: this side holds its own stream
//! of midna's events, so they arrive with the window closed to the tray. On
//! macOS they go through UNUserNotificationCenter, which asks the user for
//! permission; the notification plugin posts with NSUserNotification, which
//! macOS 26 drops until the user has allowed an app it was never asked about.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::hands::conn::{connection, Connection};

/// Where the stream got to, per connection, so a restart neither repeats nor misses.
const POSITIONS: &str = "notify.json";
/// A line older than this when it gets here (the Mac slept, the app was closed) counts in the badge, without a banner.
const FRESH_MS: f64 = 10.0 * 60_000.0;
/// A banner shows a few lines; the rest is in the chat.
const BODY_MAX: usize = 400;

#[derive(Default)]
pub struct Notifications(Mutex<State>);

#[derive(Default)]
struct State {
    /// midna's lines that came while the window wasn't being looked at.
    unread: i64,
    /// Why the last notification didn't go, when it didn't.
    problem: Option<String>,
}

/// One of midna's lines, as /v1/events sends it (OutboxItem in packages/protocol).
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub seq: i64,
    pub kind: String,
    pub text: String,
    pub priority: String,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    pub created_at: f64,
    #[serde(default)]
    pub deliver_after: f64,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Attachment {
    pub name: String,
}

/// How much a notification may interrupt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// In Notification Center and the badge, without a banner or a sound: fyi.
    Passive,
    Active,
    /// A reply, or anything urgent: through a Focus that allows time-sensitive notifications, where the app may send them.
    TimeSensitive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub level: Level,
}

/// What to do with a line that just came.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// The window is being looked at: the chat shows it.
    Nothing,
    /// It came late: the badge counts it.
    Count,
    Notify,
}

pub fn decide(item: &Item, looking: bool, now_ms: f64) -> Decision {
    if looking {
        Decision::Nothing
    } else if now_ms - item.created_at.max(item.deliver_after) > FRESH_MS {
        Decision::Count
    } else {
        Decision::Notify
    }
}

/// The notification a line becomes: midna's name over its words as plain text, a question's choices, a word on its files.
pub fn note(item: &Item, name: &str) -> Note {
    let mut body = plain(&item.text);
    if let Some(options) = item.options.as_ref().filter(|o| !o.is_empty()) {
        body.push_str(&format!("\n{}", options.iter().map(|o| plain(o)).collect::<Vec<_>>().join(" · ")));
    }
    match item.attachments.len() {
        0 => {}
        n => body.push_str(&format!("{}📎 {}", if body.is_empty() { "" } else { "\n" }, if n == 1 { item.attachments[0].name.clone() } else { format!("{n} files") })),
    }
    if body.chars().count() > BODY_MAX {
        body = format!("{}…", body.chars().take(BODY_MAX - 1).collect::<String>().trim_end());
    }
    if item.priority == "urgent" {
        body = format!("❗ {body}");
    }
    Note {
        id: format!("outbox-{}", item.id),
        title: if item.kind == "question" { format!("{name} asks") } else { name.to_string() },
        body,
        level: match (item.priority.as_str(), item.kind.as_str()) {
            ("fyi", _) => Level::Passive,
            ("urgent", _) | (_, "message") => Level::TimeSensitive,
            _ => Level::Active,
        },
    }
}

/// midna's markdown as the words alone, as plainText in packages/protocol does it, near enough for a banner:
/// the marks go, a list keeps a bullet, a table's cells are joined with " · ", code keeps its lines.
pub fn plain(md: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut fence: Option<&str> = None;
    for line in md.replace("\r\n", "\n").split('\n') {
        let t = line.trim();
        if let Some(f) = fence {
            if t.starts_with(f) {
                fence = None;
            } else {
                out.push(line.to_string());
            }
            continue;
        }
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = Some(if t.starts_with('`') { "```" } else { "~~~" });
            continue;
        }
        // A table's |---|:--:| line, and a rule, say nothing.
        let marks = |set: &str| !t.is_empty() && t.chars().all(|c| set.contains(c));
        if (t.contains('-') && t.contains('|') && marks("|-: ")) || (t.len() >= 3 && (marks("- ") || marks("* ") || marks("_ ")) && t.chars().filter(|c| !c.is_whitespace()).count() >= 3) {
            continue;
        }
        let indent = &line[..line.len() - line.trim_start().len()];
        let mut s = t.to_string();
        if let Some(h) = s.strip_prefix('#') {
            let h = h.trim_start_matches('#');
            if h.starts_with(' ') {
                s = h.trim().trim_end_matches('#').trim().to_string();
            }
        }
        if let Some(q) = s.strip_prefix('>') {
            s = q.trim_start().to_string();
        }
        for bullet in ["- ", "* ", "+ "] {
            if let Some(rest) = s.strip_prefix(bullet) {
                let rest = rest.trim_start();
                s = match (rest.strip_prefix("[ ] "), rest.strip_prefix("[x] ").or(rest.strip_prefix("[X] "))) {
                    (Some(todo), _) => format!("☐ {todo}"),
                    (_, Some(done)) => format!("☑ {done}"),
                    _ => format!("• {rest}"),
                };
                break;
            }
        }
        if s.len() > 1 && s.starts_with('|') && s.ends_with('|') {
            s = s[1..s.len() - 1].split('|').map(str::trim).collect::<Vec<_>>().join(" · ");
        }
        out.push(format!("{indent}{}", inline(&s)));
    }
    let mut joined = out.join("\n");
    while joined.contains("\n\n\n") {
        joined = joined.replace("\n\n\n", "\n\n");
    }
    joined.trim().to_string()
}

/// A line without its inline marks: a link is its words, code its text, bold and italic their words.
fn inline(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let word = |ch: Option<&char>| ch.is_some_and(|ch| ch.is_alphanumeric());
    while i < c.len() {
        match c[i] {
            // An escaped mark is itself.
            '\\' if i + 1 < c.len() && c[i + 1].is_ascii_punctuation() => {
                out.push(c[i + 1]);
                i += 2;
            }
            // ![alt](src) and [words](url): the words.
            '!' | '[' => {
                let open = if c[i] == '!' { i + 1 } else { i };
                let link = (c.get(open) == Some(&'[')).then(|| c[open..].iter().position(|&x| x == ']').map(|p| open + p)).flatten().filter(|&close| c.get(close + 1) == Some(&'('));
                match link.and_then(|close| c[close..].iter().position(|&x| x == ')').map(|p| (close, close + p))) {
                    Some((close, end)) => {
                        out.push_str(&inline(&c[open + 1..close].iter().collect::<String>()));
                        i = end + 1;
                    }
                    None => {
                        out.push(c[i]);
                        i += 1;
                    }
                }
            }
            '`' => {
                let ticks = c[i..].iter().take_while(|&&x| x == '`').count();
                let rest = &c[i + ticks..];
                match (0..rest.len()).find(|&p| rest[p..].iter().take_while(|&&x| x == '`').count() == ticks && (p == 0 || rest[p - 1] != '`')) {
                    Some(p) if p > 0 => {
                        out.push_str(rest[..p].iter().collect::<String>().trim());
                        i += ticks + p + ticks;
                    }
                    _ => {
                        out.push('`');
                        i += 1;
                    }
                }
            }
            // Emphasis marks go; an underscore inside a word (snake_case) and a lone star (2 * 3) stay.
            '*' | '~' if c.get(i + 1) == Some(&c[i]) => i += 2,
            '*' if c.get(i + 1).is_some_and(|x| !x.is_whitespace()) || (i > 0 && !c[i - 1].is_whitespace()) => i += 1,
            '_' if !(word(i.checked_sub(1).and_then(|p| c.get(p))) && word(c.get(i + 1))) && (c.get(i + 1).is_some_and(|x| !x.is_whitespace()) || (i > 0 && !c[i - 1].is_whitespace())) => {
                i += if c.get(i + 1) == Some(&'_') { 2 } else { 1 };
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// Whether the window is what the user is looking at.
fn looking(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

fn set_badge(app: &AppHandle, unread: i64) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count((unread > 0).then_some(unread));
    }
}

fn problem(app: &AppHandle, why: Option<String>) {
    if let Some(why) = &why {
        eprintln!("notify: {why}");
    }
    app.state::<Notifications>().0.lock().unwrap().problem = why;
}

/// One of midna's lines came.
fn arrived(app: &AppHandle, item: &Item, name: &str) {
    let decision = decide(item, looking(app), now_ms());
    if decision == Decision::Nothing {
        return;
    }
    let state = app.state::<Notifications>();
    let unread = {
        let mut s = state.0.lock().unwrap();
        s.unread += 1;
        s.unread
    };
    set_badge(app, unread);
    if decision == Decision::Notify {
        let n = note(item, name);
        if let Err(e) = post(app, &n) {
            problem(app, Some(e));
        }
    }
}

/// The window is being looked at: nothing is unread, and what the notifications said is in the chat.
pub fn seen(app: &AppHandle) {
    let had = std::mem::take(&mut app.state::<Notifications>().0.lock().unwrap().unread);
    if had > 0 {
        set_badge(app, 0);
    }
    #[cfg(target_os = "macos")]
    mac::clear();
}

/// A notification from midna's hands (`notify`): shown as asked, whatever the window is doing.
pub fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    post(app, &Note { id: format!("hands-{}", now_ms() as u64), title: title.to_string(), body: body.to_string(), level: Level::Active })
}

fn post(app: &AppHandle, n: &Note) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if crate::hands::mac::bundled() {
        return mac::post(app, n);
    }
    // Elsewhere, and under `tauri dev` (a bare binary has no notification center): the plugin.
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(&n.title).body(&n.body).show().map_err(|e| e.to_string())
}

// ── the stream ───────────────────────────────────────────────────────────

/// Why a session ended, and how long to wait before the next (0: back off).
struct Pause(u64);

pub fn start(app: AppHandle) {
    #[cfg(target_os = "macos")]
    mac::init(&app);
    tauri::async_runtime::spawn(async move {
        let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().expect("an HTTP client");
        let mut backoff = 1;
        loop {
            let wait = match session(&app, &http).await {
                Ok(()) => {
                    backoff = 1;
                    1
                }
                Err(Pause(0)) => {
                    let b = backoff;
                    backoff = (backoff * 2).min(30);
                    b
                }
                Err(Pause(s)) => s,
            };
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    });
}

fn same(a: &Connection, b: &Connection) -> bool {
    a.url == b.url && a.token == b.token
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    name: String,
    outbox_seq: i64,
}

async fn session(app: &AppHandle, http: &reqwest::Client) -> Result<(), Pause> {
    let Some(conn) = connection(app) else { return Err(Pause(5)) };
    // Paired, so there's something to be told about: macOS asks now, the first time only.
    static ASKED: AtomicBool = AtomicBool::new(false);
    if !ASKED.swap(true, Ordering::Relaxed) {
        #[cfg(target_os = "macos")]
        crate::hands::mac::request_notifications();
    }
    let auth = format!("Bearer {}", conn.token);
    let r = http.get(format!("{}/v1/status", conn.url)).header("authorization", &auth).timeout(Duration::from_secs(15)).send().await.map_err(|_| Pause(0))?;
    match r.status().as_u16() {
        200 => {}
        401 => return Err(Pause(60)),
        _ => return Err(Pause(0)),
    }
    let status: Status = r.json().await.map_err(|_| Pause(0))?;

    // From where this left off; the first time, and after midna was set up again (its count starts over), from now.
    let key = format!("{}#{}", conn.url, conn.device.clone().unwrap_or_default());
    let mut positions: BTreeMap<String, i64> = crate::hands::load(app, POSITIONS);
    let mut since = match positions.get(&key) {
        Some(&p) if p <= status.outbox_seq => p,
        _ => status.outbox_seq,
    };
    let mut keep = |since: i64| {
        positions.insert(key.clone(), since);
        crate::hands::save(app, POSITIONS, &positions);
    };
    keep(since);

    let stream = http
        .get(format!("{}/v1/events", conn.url))
        .query(&[("since", since)])
        .header("authorization", &auth)
        .header("accept", "text/event-stream")
        .send()
        .await
        .map_err(|_| Pause(0))?;
    if !stream.status().is_success() {
        return Err(Pause(0));
    }
    let mut bytes = stream.bytes_stream();
    let mut buf = String::new();
    loop {
        // The daemon writes a keepalive every 25 s; a minute of nothing is a dead connection.
        let chunk = match tokio::time::timeout(Duration::from_secs(60), bytes.next()).await {
            Ok(Some(Ok(c))) => c,
            _ => return Err(Pause(0)),
        };
        // Paired again, or with another midna: start over with that one.
        if !connection(app).is_some_and(|now| same(&now, &conn)) {
            return Ok(());
        }
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = buf.find("\n\n") {
            let block: String = buf.drain(..end + 2).collect();
            let data: Vec<&str> = block.lines().filter_map(|l| l.strip_prefix("data:")).map(|l| l.strip_prefix(' ').unwrap_or(l)).collect();
            if data.is_empty() {
                continue; // a keepalive comment
            }
            let Ok(event) = serde_json::from_str::<Value>(&data.join("\n")) else { continue };
            if event.get("type").and_then(Value::as_str) != Some("outbox") {
                continue;
            }
            let Some(item) = event.get("item").cloned().and_then(|i| serde_json::from_value::<Item>(i).ok()) else { continue };
            if item.seq <= since {
                continue;
            }
            since = item.seq;
            keep(since);
            arrived(app, &item, &status.name);
        }
    }
}

// ── what the window asks ─────────────────────────────────────────────────

/// Whether notifications reach the user here: "on", "ask" (never asked), "off" (refused, or turned off in System Settings), "unknown".
#[derive(Serialize)]
pub struct Setup {
    state: &'static str,
    problem: Option<String>,
}

#[tauri::command]
pub async fn notifications_status(app: AppHandle) -> Setup {
    #[cfg(target_os = "macos")]
    let state = {
        use crate::hands::PermissionState::*;
        match crate::hands::mac::notifications() {
            Granted => "on",
            NotAsked => "ask",
            NotGranted => "off",
            _ => "unknown",
        }
    };
    #[cfg(not(target_os = "macos"))]
    let state = "on";
    Setup { state, problem: app.state::<Notifications>().0.lock().unwrap().problem.clone() }
}

/// Turn them on: macOS asks if it never has, else its settings open at midna.
#[tauri::command]
pub async fn notifications_enable() {
    #[cfg(target_os = "macos")]
    match crate::hands::mac::notifications() {
        crate::hands::PermissionState::NotGranted => crate::hands::mac::open_settings("notifications"),
        _ => crate::hands::mac::request_notifications(),
    }
}

/// One now, as a reply would come, so the user hears and sees what to expect.
#[tauri::command]
pub async fn notifications_test(app: AppHandle) -> Result<(), String> {
    let n = Note { id: format!("test-{}", now_ms() as u64), title: "midna".into(), body: "This is how I'll reach you here. Click me to open the chat.".into(), level: Level::TimeSensitive };
    let sent = post(&app, &n);
    problem(&app, sent.clone().err());
    sent
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::OnceLock;

    use block2::{DynBlock, RcBlock};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, ClassType};
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotification, UNNotificationInterruptionLevel, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Emitter};

    use super::{Level, Note};

    static APP: OnceLock<AppHandle> = OnceLock::new();

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and this has no state of its own.
        #[unsafe(super(NSObject))]
        #[name = "MidnaNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            /// One posted while midna is the app in front (its window not the one looked at, or a test): shown all the same.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification, done: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
                done.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
            }

            /// Clicked: the window comes forward on the chat.
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, done: &DynBlock<dyn Fn()>) {
                let id = response.notification().request().identifier().to_string();
                if let Some(app) = APP.get() {
                    crate::show(app);
                    let _ = app.emit("notification-open", id);
                }
                done.call(());
            }
        }
    );

    /// Take clicks, from the start: a click on a notification can be what launches the app.
    pub fn init(app: &AppHandle) {
        let _ = APP.set(app.clone());
        if !crate::hands::mac::bundled() {
            return;
        }
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::class(), new] };
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly; this one lives as long as the app.
        std::mem::forget(delegate);
    }

    pub fn post(app: &AppHandle, n: &Note) -> Result<(), String> {
        autoreleasepool(|_| {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&n.title));
            content.setBody(&NSString::from_str(&n.body));
            content.setThreadIdentifier(&NSString::from_str("midna"));
            if n.level != Level::Passive {
                content.setSound(Some(&UNNotificationSound::defaultSound()));
            }
            content.setInterruptionLevel(match n.level {
                Level::Passive => UNNotificationInterruptionLevel::Passive,
                Level::Active => UNNotificationInterruptionLevel::Active,
                Level::TimeSensitive => UNNotificationInterruptionLevel::TimeSensitive,
            });
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&n.id), &content, None);
            // macOS answers later; a refusal (notifications turned off) is kept for Settings to show.
            let app = app.clone();
            let done = RcBlock::new(move |error: *mut NSError| {
                let why = (!error.is_null()).then(|| unsafe { &*error }.localizedDescription().to_string());
                super::problem(&app, why);
            });
            UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&done));
        });
        Ok(())
    }

    /// What the notifications said is in the chat now.
    pub fn clear() {
        if crate::hands::mac::bundled() {
            UNUserNotificationCenter::currentNotificationCenter().removeAllDeliveredNotifications();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(more: Value) -> Item {
        let mut v = serde_json::json!({ "id": 7, "seq": 7, "kind": "message", "conversationId": "main", "text": "Hi", "priority": "normal", "options": null, "createdAt": 1_000_000.0, "deliverAfter": 0.0, "attachments": [] });
        v.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn the_words_not_the_markdown() {
        let md = "**Nova** is `live`:\n\n- see [the demo](https://nova.example)\n\n| a | b |\n|---|---|\n| 1 | 2 |";
        assert_eq!(plain(md), "Nova is live:\n\n• see the demo\n\na · b\n1 · 2");
        assert_eq!(plain("## Plan\n> quoted *words*\n- [ ] todo\n- [x] done\n---\n```sh\nls -la *\n```"), "Plan\nquoted words\n☐ todo\n☑ done\nls -la *");
        assert_eq!(plain("snake_case stays, 2 * 3 stays, __bold__ and _it_ and ~~gone~~ go, \\*kept\\*"), "snake_case stays, 2 * 3 stays, bold and it and gone go, *kept*");
        assert_eq!(plain("![a chart](x.png) and ``a `tick` inside``"), "a chart and a `tick` inside");
    }

    #[test]
    fn a_reply_is_time_sensitive_and_fyi_is_quiet() {
        assert_eq!(note(&item(serde_json::json!({})), "midna"), Note { id: "outbox-7".into(), title: "midna".into(), body: "Hi".into(), level: Level::TimeSensitive });
        assert_eq!(note(&item(serde_json::json!({ "kind": "notification" })), "midna").level, Level::Active);
        assert_eq!(note(&item(serde_json::json!({ "priority": "fyi" })), "midna").level, Level::Passive);
        let urgent = note(&item(serde_json::json!({ "kind": "notification", "priority": "urgent" })), "midna");
        assert_eq!((urgent.body.as_str(), urgent.level), ("❗ Hi", Level::TimeSensitive));
    }

    #[test]
    fn a_question_shows_its_choices_and_files_are_named() {
        let q = note(&item(serde_json::json!({ "kind": "question", "text": "Move the **dentist**?", "options": ["Yes", "Not *yet*"] })), "midna");
        assert_eq!((q.title.as_str(), q.body.as_str()), ("midna asks", "Move the dentist?\nYes · Not yet"));
        let file = serde_json::json!({ "id": "att_1", "name": "plan.pdf", "mime": "application/pdf", "size": 1, "kind": "file", "caption": null });
        assert_eq!(note(&item(serde_json::json!({ "attachments": [file.clone()] })), "midna").body, "Hi\n📎 plan.pdf");
        assert_eq!(note(&item(serde_json::json!({ "text": "", "attachments": [file.clone(), file] })), "midna").body, "📎 2 files");
        let long = note(&item(serde_json::json!({ "text": "가".repeat(5_000) })), "midna").body;
        assert_eq!(long.chars().count(), BODY_MAX);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn looked_at_says_nothing_and_a_late_line_only_counts() {
        let fresh = item(serde_json::json!({}));
        assert_eq!(decide(&fresh, true, 1_000_500.0), Decision::Nothing);
        assert_eq!(decide(&fresh, false, 1_000_500.0), Decision::Notify);
        // The Mac slept through it.
        assert_eq!(decide(&fresh, false, 1_000_000.0 + FRESH_MS + 1.0), Decision::Count);
        // Held through quiet hours, released just now: it's news now.
        let held = item(serde_json::json!({ "deliverAfter": 9_000_000.0 }));
        assert_eq!(decide(&held, false, 9_000_500.0), Decision::Notify);
    }
}
