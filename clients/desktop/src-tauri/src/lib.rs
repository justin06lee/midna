//! The desktop shell around midna.
//!
//! Deliberately thin. Talking to midna is plain HTTP from the web view to the
//! host, with a device token. Finding machines and making one of them midna's
//! home is the `midna` binary this app carries — the same program that runs
//! on the host — driven with `--json` and streamed back line by line. What is
//! left for Rust is what a web view can't do: run that binary, remember the
//! connection, open a terminal for a sign-in, and keep a tray icon so midna
//! can still reach you with the window closed.

use std::path::PathBuf;
use std::process::Stdio;

use tauri::image::Image;
use tauri::ipc::Channel;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
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
        .invoke_handler(tauri::generate_handler![midna, connection_load, connection_save, connection_clear, open_terminal])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open midna", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit midna", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("midna")
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("midna")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show(app),
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
