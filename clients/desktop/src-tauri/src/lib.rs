//! The desktop shell around midna.
//!
//! Deliberately thin. Talking to midna is plain HTTP from the web view to the
//! host, with a device token. Finding machines and making one of them midna's
//! home is the `midna` binary this app carries — the same program that runs
//! on the host — driven with `--json` and streamed back line by line. What is
//! left for Rust is what a web view can't do: run that binary, remember the
//! connection, open a terminal for a sign-in, put the files midna sends where
//! the user can use them, and keep a tray icon so midna can still reach you
//! with the window closed. And be midna's hands on this computer (`hands`).

mod hands;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::image::Image;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

#[derive(serde::Serialize)]
struct RunResult {
    code: i32,
    stderr: String,
}

/// The `midna` binary bundled beside this app's executable. `MIDNA_BIN`
/// overrides it, for working on the app against a source checkout.
fn sidecar() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("MIDNA_BIN") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("the app has no directory")?;
    let path = dir.join(if cfg!(windows) { "midna.exe" } else { "midna" });
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("midna isn't bundled beside {}", exe.display()))
    }
}

/// Run the bundled `midna` with `args`, sending each line it prints as it
/// prints it. Builds for other platforms ride along in the app's resources
/// (`kits/`), for installing midna on a machine unlike this one.
#[tauri::command]
async fn midna(app: AppHandle, args: Vec<String>, on_line: Channel<String>) -> Result<RunResult, String> {
    let mut cmd = tokio::process::Command::new(sidecar()?);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Ok(dir) = app.path().resource_dir() {
        let kits = dir.join("kits");
        if kits.is_dir() {
            cmd.env("MIDNA_KITS", kits);
        }
    }
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start midna: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let errors = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        // The window may have gone away mid-install; the install carries on.
        let _ = on_line.send(line);
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    Ok(RunResult {
        code: status.code().unwrap_or(-1),
        stderr: errors.await.unwrap_or_default(),
    })
}

fn connection_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("connection.json"))
}

/// Which midna this app talks to, and the device token it was given.
#[tauri::command]
fn connection_load(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let file = connection_file(&app)?;
    match std::fs::read_to_string(&file) {
        Ok(s) => serde_json::from_str(&s).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Kept readable by this account only: the token is a key to the assistant.
#[tauri::command]
fn connection_save(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    let file = connection_file(&app)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

#[tauri::command]
fn connection_clear(app: AppHandle) -> Result<(), String> {
    match std::fs::remove_file(connection_file(&app)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn shell_quote(arg: &str) -> String {
    if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c)) {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|d| d.join(name).is_file()))
        .unwrap_or(false)
}

/// Open the user's terminal running `argv` — for the one thing that can't be
/// done for them, like signing in to an agent CLI on another machine.
#[tauri::command]
fn open_terminal(argv: Vec<String>) -> Result<(), String> {
    let line = argv.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ");
    #[cfg(target_os = "macos")]
    {
        let escaped = line.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!("tell application \"Terminal\"\nactivate\ndo script \"{escaped}\"\nend tell");
        std::process::Command::new("osascript").arg("-e").arg(script).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Most wanted first; each with the flag that means "run this".
        let mut known: Vec<(String, Vec<&str>)> = vec![];
        if let Ok(t) = std::env::var("TERMINAL") {
            known.push((t, vec!["-e"]));
        }
        for (name, flag) in [
            ("ghostty", vec!["-e"]),
            ("kitty", vec![]),
            ("alacritty", vec!["-e"]),
            ("wezterm", vec!["start", "--"]),
            ("foot", vec![]),
            ("gnome-terminal", vec!["--"]),
            ("konsole", vec!["-e"]),
            ("xfce4-terminal", vec!["-x"]),
            ("x-terminal-emulator", vec!["-e"]),
            ("xterm", vec!["-e"]),
        ] {
            known.push((name.to_string(), flag));
        }
        for (term, flag) in known {
            if !on_path(&term) {
                continue;
            }
            // Keep the window open afterwards so whatever happened can be read.
            let hold = format!("{line}; echo; read -p 'Press enter to close' _");
            return std::process::Command::new(&term)
                .args(flag)
                .args(["sh", "-c", &hold])
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
        Err(format!("couldn't find a terminal — run this yourself: {line}"))
    }
}

// ── files midna sent ─────────────────────────────────────────────────────
// The web view fetches an attachment with its token and hands the bytes over
// raw, with the name in a header; Rust writes them where they belong.

fn header(request: &Request<'_>, key: &str) -> Result<String, String> {
    let raw = request.headers().get(key).and_then(|v| v.to_str().ok()).ok_or(format!("no {key}"))?;
    // The name comes percent-encoded: a header carries only ASCII.
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("expected the file's bytes".into()),
    }
}

/// A name midna gave a file, made safe to write: no folders, nothing hidden.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control() && *c != ':').collect();
    let clean = clean.trim().trim_start_matches('.').trim();
    if clean.is_empty() {
        "attachment".into()
    } else {
        clean.chars().take(200).collect()
    }
}

/// Write `bytes` as a new file in `dir`: `name`, or `name (1)`, `name (2)`… if taken.
fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    for n in 0..1000 {
        let path = dir.join(if n == 0 { name.to_string() } else { format!("{stem} ({n}){ext}") });
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                f.write_all(bytes).map_err(|e| e.to_string())?;
                quarantine(&path);
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err(format!("couldn't find a free name for {name}"))
}

/// Mark a file as downloaded, the way a browser does, so Gatekeeper checks
/// anything runnable before it runs: a file midna sent is still from the internet.
fn quarantine(path: &Path) {
    #[cfg(target_os = "macos")]
    {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = std::process::Command::new("/usr/bin/xattr")
            .args(["-w", "com.apple.quarantine", &format!("0083;{secs:x};midna;")])
            .arg(path)
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = path;
}

/// Save a file midna sent into Downloads; answers where it went.
#[tauri::command]
fn save_download(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let name = safe_name(&header(&request, "x-name")?);
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let path = write_new(&dir, &name, body(&request)?)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Show a file in Finder — only one this app put in Downloads.
#[tauri::command]
fn show_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let path = PathBuf::from(path);
    if path.parent() != Some(dir.as_path()) || !path.is_file() {
        return Err("that isn't a file midna saved".into());
    }
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

/// Open a file midna sent in its default app, from a copy in the app's cache.
#[tauri::command]
fn open_attachment(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let id: String = header(&request, "x-id")?.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if id.is_empty() {
        return Err("no attachment id".into());
    }
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("attachments").join(id);
    let name = safe_name(&header(&request, "x-name")?);
    // An attachment never changes: open the copy made last time, if there is one.
    let path = if dir.join(&name).is_file() { dir.join(&name) } else { write_new(&dir, &name, body(&request)?)? };
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

// ── files copied in Finder ───────────────────────────────────────────────
// A paste of several files gives the web view only the first; the app reads
// the list itself, and only ever reads a file that is on the clipboard.

#[cfg(target_os = "macos")]
fn copied_paths() -> Vec<PathBuf> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::NSURL;
    let Some(items) = NSPasteboard::generalPasteboard().pasteboardItems() else {
        return vec![];
    };
    items
        .iter()
        .filter_map(|item| item.stringForType(unsafe { NSPasteboardTypeFileURL }))
        .filter_map(|s| NSURL::URLWithString(&s)?.path())
        .map(|p| PathBuf::from(p.to_string()))
        .filter(|p| p.is_file())
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn copied_paths() -> Vec<PathBuf> {
    vec![]
}

#[derive(serde::Serialize)]
struct Copied {
    path: String,
    name: String,
    size: u64,
}

/// The files on the clipboard, in the order they were copied.
#[tauri::command]
fn copied_files() -> Vec<Copied> {
    copied_paths()
        .into_iter()
        .map(|p| Copied {
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            size: std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0),
            path: p.to_string_lossy().into_owned(),
        })
        .collect()
}

/// One of those files' bytes — only while it is still on the clipboard.
#[tauri::command]
async fn read_copied(path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    if !copied_paths().contains(&path) {
        return Err("that file isn't on the clipboard any more".into());
    }
    tokio::fs::read(&path).await.map(Response::new).map_err(|e| e.to_string())
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .invoke_handler(tauri::generate_handler![
            midna,
            connection_load,
            connection_save,
            connection_clear,
            open_terminal,
            save_download,
            show_in_folder,
            open_attachment,
            copied_files,
            read_copied,
            hands::hands_status,
            hands::hands_set_offer,
            hands::hands_set_paused,
            hands::hands_defaults,
            hands::permission_request,
            hands::permission_open,
            hands::hands_approvals,
            hands::hands_answer,
            hands::relaunch
        ])
        .setup(|app| {
            app.manage(hands::init(app.handle()));
            app.manage(hands::conn::Poke(std::sync::Arc::new(tokio::sync::Notify::new())));
            hands::conn::start(app.handle().clone());
            // ⌃⌥⌘P pauses or resumes midna's hands from anywhere; a registered hotkey needs no Input Monitoring.
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                let pause = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER), Code::KeyP);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, e| {
                            if *shortcut == pause && e.state() == ShortcutState::Pressed {
                                hands::toggle_pause(app);
                            }
                        })
                        .build(),
                )?;
                if let Err(e) = app.global_shortcut().register(pause) {
                    eprintln!("couldn't take ⌃⌥⌘P for pausing midna's hands: {e}");
                }
            }
            TrayIconBuilder::with_id("midna")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("midna")
                .menu(&hands::tray_menu(app.handle())?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show(app),
                    "pause" => hands::toggle_pause(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show(tray.app_handle());
                    }
                })
                .build(app)?;
            // Launched at login: stay in the tray until asked for.
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it: midna keeps reaching you from the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("midna failed to start");
}
