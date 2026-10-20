//! The operations past seeing and opening: the mouse and keyboard, scripts,
//! the shell, files and the clipboard. Each takes packages/protocol's args
//! for its op and answers with its data, and any files to upload with the
//! result. A pointer's coordinates are pixels in the latest screenshot of
//! its display; a file's path is absolute or starts with ~.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use super::{Link, Outcome, Refusal, Shared, Upload};

/// packages/protocol's SHELL_INLINE_BYTES and FILE_TEXT_BYTES.
const SHELL_INLINE_BYTES: usize = 32 * 1024;
const FILE_TEXT_BYTES: u64 = 64 * 1024;
/// The most of a stream, file or listing kept: an attachment's limit, and the protocol's entry cap.
const MAX_BYTES: usize = 100 * 1024 * 1024;
const MAX_ENTRIES: usize = 1000;

fn bad(msg: impl Into<String>) -> Refusal {
    Refusal::new("bad_args", msg)
}

fn failed(msg: impl Into<String>) -> Refusal {
    Refusal::new("failed", msg)
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn num_arg(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(Value::as_f64)
}

// ── the mouse and keyboard ───────────────────────────────────────────────

/// A point in a screenshot's pixels, in the global layout's points.
fn to_points(app: &AppHandle, display: Option<&str>, x: f64, y: f64) -> Result<(f64, f64), Refusal> {
    let all = super::displays();
    let d = match display {
        Some(id) => all.iter().find(|d| d.id == id).ok_or_else(|| bad(format!("there's no display {id}")))?,
        None => all.iter().find(|d| d.primary).or(all.first()).ok_or_else(|| failed("no display"))?,
    };
    let shot = app.state::<Shared>().lock().unwrap().shots.get(&d.id).copied().unwrap_or_else(|| default_shot_width(d));
    let k = d.width / shot.max(1) as f64;
    let shot_h = d.height / k;
    if !(0.0..=shot as f64).contains(&x) || !(0.0..=shot_h).contains(&y) {
        return Err(bad(format!("({x}, {y}) is outside display {}'s screenshot, {shot}×{} pixels", d.id, shot_h.round())));
    }
    Ok((d.x + x * k, d.y + y * k))
}

/// A screenshot's width when none has been taken of the display yet: its long edge scaled to 1568.
fn default_shot_width(d: &super::Display) -> u32 {
    let (w, h) = (d.width * d.scale, d.height * d.scale);
    let long = w.max(h);
    (if long > 1568.0 { w * 1568.0 / long } else { w }).round() as u32
}

pub async fn input(app: &AppHandle, op: &str, args: &Value) -> Result<Outcome, Refusal> {
    #[cfg(target_os = "macos")]
    {
        use super::mac;
        if mac::user_active() {
            return Err(Refusal::new("user_active", "the user is using the mouse or keyboard; try again once they've stopped"));
        }
        let display = str_arg(args, "display");
        let button = str_arg(args, "button").unwrap_or("left").to_string();
        // Each step is a few events and short sleeps: off the async threads.
        let step: Box<dyn FnOnce() -> Result<(), String> + Send> = match op {
            "click" | "move" => {
                let (x, y) = to_points(app, display, num_arg(args, "x").ok_or_else(|| bad("x is required"))?, num_arg(args, "y").ok_or_else(|| bad("y is required"))?)?;
                if op == "move" {
                    Box::new(move || mac::move_to(x, y))
                } else {
                    let count = args.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 3) as u32;
                    Box::new(move || mac::click(x, y, &button, count))
                }
            }
            "drag" => {
                let path = args.get("path").and_then(Value::as_array).ok_or_else(|| bad("drag needs a path"))?;
                let points = path
                    .iter()
                    .map(|p| to_points(app, display, p.get("x").and_then(Value::as_f64).unwrap_or(-1.0), p.get("y").and_then(Value::as_f64).unwrap_or(-1.0)))
                    .collect::<Result<Vec<_>, _>>()?;
                if points.len() < 2 {
                    return Err(bad("drag needs at least two points"));
                }
                Box::new(move || mac::drag(&points, &button))
            }
            "scroll" => {
                let at = match (num_arg(args, "x"), num_arg(args, "y")) {
                    (Some(x), Some(y)) => Some(to_points(app, display, x, y)?),
                    _ => None,
                };
                let (dx, dy) = (num_arg(args, "dx").unwrap_or(0.0), num_arg(args, "dy").unwrap_or(0.0));
                Box::new(move || {
                    if let Some((x, y)) = at {
                        mac::move_to(x, y)?;
                    }
                    mac::scroll(dx, dy)
                })
            }
            "type" => {
                let text = str_arg(args, "text").ok_or_else(|| bad("type needs text"))?.to_string();
                Box::new(move || mac::type_text(&text))
            }
            "key" => {
                let (code, flags) = mac::chord(str_arg(args, "keys").ok_or_else(|| bad("key needs keys"))?).map_err(bad)?;
                Box::new(move || mac::key(code, flags))
            }
            _ => return Err(Refusal::new("unsupported", format!("this computer doesn't know {op}"))),
        };
        tauri::async_runtime::spawn_blocking(step)
            .await
            .map_err(|e| failed(e.to_string()))?
            .map_err(|e| if e == mac::USER_TOOK_OVER { Refusal::new("user_active", e) } else { failed(e) })?;
        Ok(Outcome { data: json!({}), files: vec![] })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, op, args);
        Err(Refusal::new("unsupported", "the mouse and keyboard come to Linux later"))
    }
}

// ── scripts and the shell ────────────────────────────────────────────────

/// Kills a process group when dropped: a command that times out or is cancelled takes its children with it.
struct Group(Option<i32>);

impl Drop for Group {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
        }
    }
}

/// All of a stream, up to MAX_BYTES; past that it's read and dropped, so the process isn't stuck writing.
async fn drain(mut r: impl AsyncRead + Unpin) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut cut = false;
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) if out.len() + n <= MAX_BYTES => out.extend_from_slice(&buf[..n]),
            Ok(_) => cut = true,
        }
    }
    (out, cut)
}

/// Run a program in its own process group, its stdin fed `input`, and collect what it writes.
async fn spawn(mut cmd: std::process::Command, input: Option<&str>) -> Result<(Option<i32>, Vec<u8>, Vec<u8>, bool), Refusal> {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = tokio::process::Command::from(cmd).kill_on_drop(true).spawn().map_err(|e| failed(e.to_string()))?;
    let mut group = Group(child.id().map(|p| p as i32));
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(text.as_bytes()).await.map_err(|e| failed(e.to_string()))?;
    }
    let (out, err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let ((stdout, cut_out), (stderr, cut_err), status) = tokio::join!(drain(out), drain(err), child.wait());
    let status = status.map_err(|e| failed(e.to_string()))?;
    // It ended by itself; whatever it left running in its group goes too.
    drop(std::mem::replace(&mut group, Group(None)));
    Ok((status.code(), stdout, stderr, cut_out || cut_err))
}

/// The first `max` bytes of a stream as text, cut on a character boundary.
fn head(bytes: &[u8], max: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= max {
        return text.into_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

pub async fn script(args: &Value) -> Result<Outcome, Refusal> {
    let source = str_arg(args, "source").ok_or_else(|| bad("script needs source"))?;
    let language = if str_arg(args, "language") == Some("jxa") { "JavaScript" } else { "AppleScript" };
    let mut cmd = std::process::Command::new("/usr/bin/osascript");
    cmd.args(["-l", language]);
    let (code, stdout, stderr, _) = spawn(cmd, Some(source)).await?;
    let err = String::from_utf8_lossy(&stderr).trim().to_string();
    if code != Some(0) {
        // -1743: the user hasn't let midna.app automate that app.
        if err.contains("-1743") || err.contains("Not authorized to send Apple events") {
            return Err(Refusal { permission: Some("automation"), ..Refusal::new("permission", format!("macOS didn't let midna.app control that app: {err}")) });
        }
        return Err(failed(if err.is_empty() { "the script failed".to_string() } else { err }));
    }
    Ok(Outcome { data: json!({ "result": head(&stdout, SHELL_INLINE_BYTES).trim_end() }), files: vec![] })
}

pub async fn shell(args: &Value) -> Result<Outcome, Refusal> {
    let command = str_arg(args, "command").ok_or_else(|| bad("shell needs a command"))?;
    let cwd = match str_arg(args, "cwd") {
        Some(p) => expand(p)?,
        None => home(),
    };
    let login = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    let mut cmd = std::process::Command::new(&login);
    cmd.arg("-lc").arg(command).current_dir(&cwd);
    if let Some(env) = args.get("env").and_then(Value::as_object) {
        cmd.envs(env.iter().filter_map(|(k, v)| v.as_str().map(|v| (k, v))));
    }
    let (code, stdout, stderr, cut) = spawn(cmd, None).await?;
    let mut files = vec![];
    for (name, bytes) in [("stdout.txt", &stdout), ("stderr.txt", &stderr)] {
        if bytes.len() > SHELL_INLINE_BYTES {
            files.push(Upload { name: name.into(), mime: "text/plain".into(), bytes: bytes.clone() });
        }
    }
    let truncated = cut || !files.is_empty();
    Ok(Outcome { data: json!({ "exit": code, "stdout": head(&stdout, SHELL_INLINE_BYTES), "stderr": head(&stderr, SHELL_INLINE_BYTES), "truncated": truncated }), files })
}

// ── files ────────────────────────────────────────────────────────────────

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// An absolute path, or one under ~.
fn expand(path: &str) -> Result<PathBuf, Refusal> {
    if path == "~" {
        return Ok(home());
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return Ok(home().join(rest));
    }
    let p = PathBuf::from(path);
    if p.is_absolute() {
        Ok(p)
    } else {
        Err(bad(format!("{path} isn't absolute: start it with / or ~")))
    }
}

/// Why a file operation failed, in words; a refusal from macOS's privacy rules names Full Disk Access.
fn io_refusal(path: &Path, e: std::io::Error) -> Refusal {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => Refusal { permission: Some("full_disk_access"), ..Refusal::new("permission", format!("macOS didn't let midna.app into {}: {e}", path.display())) },
        std::io::ErrorKind::NotFound => failed(format!("{} doesn't exist", path.display())),
        _ => failed(format!("{}: {e}", path.display())),
    }
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64)
}

pub async fn file_read(args: &Value) -> Result<Outcome, Refusal> {
    let path = expand(str_arg(args, "path").ok_or_else(|| bad("file_read needs a path"))?)?;
    let meta = tokio::fs::metadata(&path).await.map_err(|e| io_refusal(&path, e))?;
    if meta.is_dir() {
        return Err(bad(format!("{} is a folder: list it with file_list", path.display())));
    }
    let size = meta.len();
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0).min(size);
    let length = args.get("length").and_then(Value::as_u64).unwrap_or(size - offset).min(size - offset);
    if length as usize > MAX_BYTES {
        return Err(bad(format!("{} is {size} bytes: read it in parts of at most {MAX_BYTES} with offset and length", path.display())));
    }
    let mut f = tokio::fs::File::open(&path).await.map_err(|e| io_refusal(&path, e))?;
    if offset > 0 {
        use tokio::io::AsyncSeekExt;
        f.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| io_refusal(&path, e))?;
    }
    let mut bytes = vec![0u8; length as usize];
    f.read_exact(&mut bytes).await.map_err(|e| io_refusal(&path, e))?;
    let shown = path.display().to_string();
    let text = (length <= FILE_TEXT_BYTES && !bytes.contains(&0)).then(|| String::from_utf8(bytes.clone()).ok()).flatten();
    let files = if text.is_none() {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        vec![Upload { name, mime: "application/octet-stream".into(), bytes }]
    } else {
        vec![]
    };
    Ok(Outcome { data: json!({ "path": shown, "size": size, "text": text }), files })
}

pub async fn file_list(args: &Value) -> Result<Outcome, Refusal> {
    let path = expand(str_arg(args, "path").ok_or_else(|| bad("file_list needs a path"))?)?;
    let mut dir = tokio::fs::read_dir(&path).await.map_err(|e| io_refusal(&path, e))?;
    let mut entries = vec![];
    let mut truncated = false;
    while let Some(e) = dir.next_entry().await.map_err(|e| io_refusal(&path, e))? {
        if entries.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        let meta = tokio::fs::symlink_metadata(e.path()).await.ok();
        let kind = match &meta {
            Some(m) if m.is_symlink() => "link",
            Some(m) if m.is_dir() => "dir",
            Some(m) if m.is_file() => "file",
            _ => "other",
        };
        entries.push(json!({
            "name": e.file_name().to_string_lossy(),
            "kind": kind,
            "size": meta.as_ref().filter(|m| m.is_file()).map(|m| m.len()),
            "modifiedAt": meta.as_ref().and_then(|m| ms(m.modified())),
        }));
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(Outcome { data: json!({ "path": path.display().to_string(), "entries": entries, "truncated": truncated }), files: vec![] })
}

/// An attachment's bytes, its type and its name, from the daemon.
async fn fetch(link: &Link, id: &str) -> Result<(Vec<u8>, String, String), Refusal> {
    let r = link
        .http
        .get(format!("{}/v1/attachments/{id}", link.url))
        .header("authorization", format!("Bearer {}", link.token))
        .send()
        .await
        .map_err(|e| failed(format!("couldn't fetch {id}: {e}")))?;
    if !r.status().is_success() {
        return Err(bad(format!("there's no attachment {id}")));
    }
    let mime = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_string();
    let name = r
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split("filename*=UTF-8''").nth(1))
        .map(|n| percent_decode(n.trim_matches('"')))
        .unwrap_or_else(|| "file".into());
    let bytes = r.bytes().await.map_err(|e| failed(e.to_string()))?.to_vec();
    Ok((bytes, mime, name))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).replace(['/', '\\'], "_")
}

pub async fn file_write(link: &Link, args: &Value) -> Result<Outcome, Refusal> {
    let path = expand(str_arg(args, "path").ok_or_else(|| bad("file_write needs a path"))?)?;
    let bytes = match (str_arg(args, "text"), str_arg(args, "attachmentId")) {
        (Some(t), None) => t.as_bytes().to_vec(),
        (None, Some(id)) => fetch(link, id).await?.0,
        _ => return Err(bad("file_write takes text or attachmentId, not both")),
    };
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| io_refusal(parent, e))?;
    }
    let mut open = tokio::fs::OpenOptions::new();
    match str_arg(args, "mode").unwrap_or("create") {
        "overwrite" => open.write(true).create(true).truncate(true),
        "append" => open.append(true).create(true),
        _ => open.write(true).create_new(true),
    };
    let mut f = open.open(&path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            bad(format!("{} already exists: write it with mode overwrite or append", path.display()))
        } else {
            io_refusal(&path, e)
        }
    })?;
    f.write_all(&bytes).await.map_err(|e| io_refusal(&path, e))?;
    f.flush().await.map_err(|e| io_refusal(&path, e))?;
    Ok(Outcome { data: json!({ "bytes": bytes.len() }), files: vec![] })
}

// ── the clipboard ────────────────────────────────────────────────────────

pub async fn clipboard_read() -> Result<Outcome, Refusal> {
    #[cfg(target_os = "macos")]
    {
        let (text, image) = tauri::async_runtime::spawn_blocking(super::mac::clipboard_read).await.map_err(|e| failed(e.to_string()))?;
        let files = image.map(|bytes| vec![Upload { name: "clipboard.png".into(), mime: "image/png".into(), bytes }]).unwrap_or_default();
        Ok(Outcome { data: json!({ "text": text }), files })
    }
    #[cfg(not(target_os = "macos"))]
    Err(Refusal::new("unsupported", "the clipboard comes to Linux later"))
}

pub async fn clipboard_write(link: &Link, args: &Value) -> Result<Outcome, Refusal> {
    #[cfg(target_os = "macos")]
    {
        use super::mac;
        let wrote = match (str_arg(args, "text"), str_arg(args, "attachmentId")) {
            (Some(t), None) => {
                let t = t.to_string();
                tauri::async_runtime::spawn_blocking(move || mac::clipboard_write_text(&t)).await
            }
            (None, Some(id)) => {
                let (bytes, mime, name) = fetch(link, id).await?;
                tauri::async_runtime::spawn_blocking(move || {
                    if mime == "image/png" {
                        mac::clipboard_write_image(&bytes)
                    } else if mime.starts_with("text/") {
                        mac::clipboard_write_text(&String::from_utf8_lossy(&bytes))
                    } else {
                        // Anything else goes on as a file, the way Finder copies one; images are turned into PNG first.
                        let dir = std::env::temp_dir().join("midna-clipboard");
                        let _ = std::fs::create_dir_all(&dir);
                        let file = dir.join(&name);
                        std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
                        if mime.starts_with("image/") {
                            let png = dir.join("clipboard.png");
                            let ok = std::process::Command::new("/usr/bin/sips").args(["-s", "format", "png"]).arg(&file).arg("--out").arg(&png).stdout(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
                            if ok {
                                return mac::clipboard_write_image(&std::fs::read(&png).map_err(|e| e.to_string())?);
                            }
                        }
                        mac::clipboard_write_file(&file)
                    }
                })
                .await
            }
            _ => return Err(bad("clipboard_write takes text or attachmentId, not both")),
        };
        wrote.map_err(|e| failed(e.to_string()))?.map_err(failed)?;
        Ok(Outcome { data: json!({}), files: vec![] })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (link, args);
        Err(Refusal::new("unsupported", "the clipboard comes to Linux later"))
    }
}
