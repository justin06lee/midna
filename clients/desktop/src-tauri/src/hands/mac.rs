//! What only macOS can answer: which permissions midna.app holds, the
//! displays and whether the screen is locked, and taking a screenshot.
//!
//! Every check runs in this process, so it answers for midna.app — the
//! process TCC holds responsible for anything the app starts, too.

use std::ffi::c_void;
use std::path::Path;
use std::process::Command;

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::{CFString, CFStringRef};

use super::{Display, PermissionState};

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CGRect;
    fn CGDisplayCopyDisplayMode(display: u32) -> *mut c_void;
    fn CGDisplayModeGetPixelWidth(mode: *mut c_void) -> usize;
    fn CGDisplayModeRelease(mode: *mut c_void);
    fn CGDisplayIsBuiltin(display: u32) -> u32;
    fn CGDisplayIsAsleep(display: u32) -> u32;
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    fn CGEventCreate(source: *const c_void) -> *const c_void;
    fn CGEventGetLocation(event: *const c_void) -> CGPoint;
    fn CFRelease(cf: *const c_void);
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

#[repr(C)]
struct AEDesc {
    descriptor_type: u32,
    data_handle: *mut c_void,
}

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn AECreateDesc(type_code: u32, data: *const c_void, size: isize, result: *mut AEDesc) -> i16;
    fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
    fn AEDeterminePermissionToAutomateTarget(target: *const AEDesc, class: u32, id: u32, ask: u8) -> i32;
}

const fn four(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

// ── permissions ──────────────────────────────────────────────────────────

pub fn screen_recording() -> PermissionState {
    // True only once midna has been relaunched after the grant; the screen says so.
    if unsafe { CGPreflightScreenCaptureAccess() } { PermissionState::Granted } else { PermissionState::NotGranted }
}

pub fn request_screen_recording() {
    unsafe { CGRequestScreenCaptureAccess() };
}

pub fn accessibility() -> PermissionState {
    if unsafe { AXIsProcessTrusted() } { PermissionState::Granted } else { PermissionState::NotGranted }
}

pub fn request_accessibility() {
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) };
}

/// May midna.app send Apple events to the app with this bundle id. `ask` shows the consent prompt when it hasn't been asked.
pub fn automation(bundle_id: &str, ask: bool) -> PermissionState {
    let mut desc = AEDesc { descriptor_type: 0, data_handle: std::ptr::null_mut() };
    let made = unsafe { AECreateDesc(four(b"bund"), bundle_id.as_ptr() as *const c_void, bundle_id.len() as isize, &mut desc) };
    if made != 0 {
        return PermissionState::Unknown;
    }
    let status = unsafe { AEDeterminePermissionToAutomateTarget(&desc, four(b"****"), four(b"****"), ask as u8) };
    unsafe { AEDisposeDesc(&mut desc) };
    match status {
        0 => PermissionState::Granted,
        -1743 => PermissionState::NotGranted,
        -1744 => PermissionState::NotAsked,
        -600 => PermissionState::NotRunning,
        _ => PermissionState::Unknown,
    }
}

/// Start an app out of sight, so its Automation consent can be asked for.
pub fn launch_hidden(bundle_id: &str) {
    let _ = Command::new("/usr/bin/open").args(["-g", "-j", "-b", bundle_id]).status();
}

/// Full Disk Access has no API: reading the system's TCC database is allowed only with it.
pub fn full_disk_access() -> PermissionState {
    match std::fs::File::open("/Library/Application Support/com.apple.TCC/TCC.db") {
        Ok(_) => PermissionState::Granted,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => PermissionState::NotGranted,
        Err(_) => PermissionState::Unknown,
    }
}

/// Notification center calls need a real app bundle; `tauri dev` runs a bare binary.
fn bundled() -> bool {
    use objc2_foundation::NSBundle;
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

pub fn notifications() -> PermissionState {
    use objc2_user_notifications::{UNAuthorizationStatus, UNNotificationSettings, UNUserNotificationCenter};
    if !bundled() {
        return PermissionState::Unknown;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let block = block2::RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
        let _ = tx.send(unsafe { settings.as_ref() }.authorizationStatus());
    });
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.getNotificationSettingsWithCompletionHandler(&block);
    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(s) if s == UNAuthorizationStatus::Authorized || s == UNAuthorizationStatus::Provisional => PermissionState::Granted,
        Ok(s) if s == UNAuthorizationStatus::NotDetermined => PermissionState::NotAsked,
        Ok(_) => PermissionState::NotGranted,
        Err(_) => PermissionState::Unknown,
    }
}

pub fn request_notifications() {
    use objc2::runtime::Bool;
    use objc2_foundation::NSError;
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};
    if !bundled() {
        return;
    }
    let block = block2::RcBlock::new(|_granted: Bool, _error: *mut NSError| {});
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &block);
}

/// The System Settings pane for one permission.
pub fn open_settings(pane: &str) {
    let url = match pane {
        "screen_recording" => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        "accessibility" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        "automation" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
        "full_disk_access" => "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
        "notifications" => "x-apple.systempreferences:com.apple.preference.notifications?id=sh.midna.desktop",
        _ => "x-apple.systempreferences:com.apple.preference.security",
    };
    let _ = Command::new("/usr/bin/open").arg(url).status();
}

// ── the screen ───────────────────────────────────────────────────────────

fn display_ids() -> Vec<u32> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    if unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) } != 0 {
        return vec![];
    }
    ids[..count as usize].to_vec()
}

/// A display's width in real pixels: the mode's, since CGDisplayPixelsWide gives points on a Retina display.
fn pixel_width(id: u32) -> usize {
    unsafe {
        let mode = CGDisplayCopyDisplayMode(id);
        if mode.is_null() {
            return 0;
        }
        let w = CGDisplayModeGetPixelWidth(mode);
        CGDisplayModeRelease(mode);
        w
    }
}

/// Every display, in points of the global layout, main display first.
pub fn displays() -> Vec<Display> {
    let main = unsafe { CGMainDisplayID() };
    let mut external = 0;
    display_ids()
        .into_iter()
        .map(|id| {
            let b = unsafe { CGDisplayBounds(id) };
            let builtin = unsafe { CGDisplayIsBuiltin(id) } != 0;
            let name = if builtin {
                "Built-in display".to_string()
            } else {
                external += 1;
                format!("Display {external}")
            };
            Display {
                id: id.to_string(),
                name,
                primary: id == main,
                x: b.origin.x,
                y: b.origin.y,
                width: b.size.width,
                height: b.size.height,
                scale: pixel_width(id) as f64 / b.size.width.max(1.0),
            }
        })
        .collect()
}

pub fn locked() -> bool {
    let dict = unsafe { CGSessionCopyCurrentDictionary() };
    if dict.is_null() {
        return false;
    }
    let dict: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(dict) };
    dict.find(CFString::from_static_string("CGSSessionScreenIsLocked"))
        .and_then(|v| v.downcast::<CFBoolean>())
        .map(bool::from)
        .unwrap_or(false)
}

pub fn display_asleep() -> bool {
    unsafe { CGDisplayIsAsleep(CGMainDisplayID()) != 0 }
}

/// Wake the displays as a touch of the keyboard would (`caffeinate -u` declares the user active), and wait for them to light.
pub fn wake_display() {
    let _ = Command::new("/usr/bin/caffeinate").args(["-u", "-t", "2"]).spawn();
    for _ in 0..20 {
        if !display_asleep() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    // A display that just woke draws its first frames black.
    std::thread::sleep(std::time::Duration::from_millis(500));
}

/// Where the pointer is, in points of the global layout.
pub fn cursor() -> (f64, f64) {
    unsafe {
        let e = CGEventCreate(std::ptr::null());
        if e.is_null() {
            return (0.0, 0.0);
        }
        let p = CGEventGetLocation(e);
        CFRelease(e);
        (p.x, p.y)
    }
}

/// One display as a PNG at `out`, its long edge at most `max_edge` pixels (None: full size). `screencapture` numbers displays from 1, main first, as CoreGraphics lists them.
pub fn screenshot(display: &str, max_edge: Option<u32>, out: &Path) -> Result<(), String> {
    let index = display_ids().iter().position(|id| id.to_string() == display).ok_or_else(|| format!("there's no display {display}"))? + 1;
    let status = Command::new("/usr/sbin/screencapture")
        .args(["-x", "-C", "-t", "png", "-D", &index.to_string()])
        .arg(out)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() || !out.exists() {
        return Err("screencapture didn't take the picture".into());
    }
    if let Some(edge) = max_edge {
        let status = Command::new("/usr/bin/sips").args(["-Z", &edge.to_string()]).arg(out).stdout(std::process::Stdio::null()).status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("sips couldn't scale the picture".into());
        }
    }
    Ok(())
}

/// The pixel size of a PNG, from its header.
pub fn png_size(bytes: &[u8]) -> (u32, u32) {
    if bytes.len() < 24 {
        return (0, 0);
    }
    let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    (w, h)
}

/// Keep a window out of every screen capture — midna's own screenshots included.
pub fn exclude_from_capture(ns_window: *mut c_void) {
    use objc2_app_kit::{NSWindow, NSWindowSharingType};
    if ns_window.is_null() {
        return;
    }
    let window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
    window.setSharingType(NSWindowSharingType::None);
}

// ── the mouse and keyboard ───────────────────────────────────────────────

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state: i32) -> *mut c_void;
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    fn CGEventCreateMouseEvent(source: *mut c_void, mouse_type: u32, position: CGPoint, button: u32) -> *mut c_void;
    fn CGEventCreateKeyboardEvent(source: *mut c_void, key: u16, down: bool) -> *mut c_void;
    fn CGEventCreateScrollWheelEvent2(source: *mut c_void, units: u32, count: u32, wheel1: i32, wheel2: i32, wheel3: i32) -> *mut c_void;
    fn CGEventKeyboardSetUnicodeString(event: *mut c_void, length: usize, string: *const u16);
    fn CGEventSetFlags(event: *mut c_void, flags: u64);
    fn CGEventSetIntegerValueField(event: *mut c_void, field: u32, value: i64);
    fn CGEventPost(tap: u32, event: *mut c_void);
}

const HID_SYSTEM_STATE: i32 = 1;
const PRIVATE_STATE: i32 = -1;
const ANY_INPUT: u32 = !0;
const HID_TAP: u32 = 0;
const CLICK_STATE: u32 = 1;
const PIXEL_UNITS: u32 = 0;

/// When midna last posted an event. The HID idle time counts posted events
/// too, so input newer than midna's own is the user's.
static LAST_POST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
/// How long the user must have left the mouse and keyboard alone before midna takes them.
const QUIET: f64 = 2.0;
/// Slack between posting an event and the system counting it.
const SLACK: f64 = 0.15;

/// Whether the user is using the mouse or keyboard: the latest input is
/// under two seconds old, and isn't one of midna's own events.
pub fn user_active() -> bool {
    let idle = unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT) };
    let since_ours = LAST_POST.lock().unwrap().map(|t| t.elapsed().as_secs_f64());
    let latest_is_ours = since_ours.is_some_and(|since| idle + SLACK >= since);
    idle < QUIET && !latest_is_ours
}

fn post(event: *mut c_void) -> Result<(), String> {
    if event.is_null() {
        return Err("couldn't make the input event".into());
    }
    unsafe {
        CGEventPost(HID_TAP, event);
        CFRelease(event);
    }
    *LAST_POST.lock().unwrap() = Some(std::time::Instant::now());
    std::thread::sleep(std::time::Duration::from_millis(8));
    Ok(())
}

fn source() -> *mut c_void {
    unsafe { CGEventSourceCreate(PRIVATE_STATE) }
}

/// Mouse event types for a button: (down, up, dragged), and its CoreGraphics number.
fn button_events(button: &str) -> (u32, u32, u32, u32) {
    match button {
        "right" => (3, 4, 7, 1),
        "middle" => (25, 26, 27, 2),
        _ => (1, 2, 6, 0),
    }
}

pub fn move_to(x: f64, y: f64) -> Result<(), String> {
    post(unsafe { CGEventCreateMouseEvent(source(), 5, CGPoint { x, y }, 0) })
}

pub fn click(x: f64, y: f64, button: &str, count: u32) -> Result<(), String> {
    let (down, up, _, b) = button_events(button);
    move_to(x, y)?;
    let src = source();
    for n in 1..=count.max(1) {
        for kind in [down, up] {
            let e = unsafe { CGEventCreateMouseEvent(src, kind, CGPoint { x, y }, b) };
            if !e.is_null() {
                unsafe { CGEventSetIntegerValueField(e, CLICK_STATE, n as i64) };
            }
            post(e)?;
        }
    }
    Ok(())
}

/// Press at the first point, move through the rest, release at the last; stops when the user takes over.
pub fn drag(path: &[(f64, f64)], button: &str) -> Result<(), String> {
    let (down, up, dragged, b) = button_events(button);
    let Some(&(x0, y0)) = path.first() else { return Ok(()) };
    move_to(x0, y0)?;
    post(unsafe { CGEventCreateMouseEvent(source(), down, CGPoint { x: x0, y: y0 }, b) })?;
    let mut last = (x0, y0);
    let mut stopped = false;
    'path: for &(x, y) in &path[1..] {
        // In small steps, so the app sees a drag rather than a jump.
        let steps = (((x - last.0).hypot(y - last.1)) / 12.0).ceil().max(1.0) as usize;
        for i in 1..=steps {
            if user_active() {
                stopped = true;
                break 'path;
            }
            let t = i as f64 / steps as f64;
            let p = CGPoint { x: last.0 + (x - last.0) * t, y: last.1 + (y - last.1) * t };
            post(unsafe { CGEventCreateMouseEvent(source(), dragged, p, b) })?;
        }
        last = (x, y);
    }
    // Always let go, so no button is left held down.
    post(unsafe { CGEventCreateMouseEvent(source(), up, CGPoint { x: last.0, y: last.1 }, b) })?;
    if stopped {
        return Err(USER_TOOK_OVER.into());
    }
    Ok(())
}

pub const USER_TOOK_OVER: &str = "the user took the mouse or keyboard, so midna stopped";

pub fn scroll(dx: f64, dy: f64) -> Result<(), String> {
    // Positive dy scrolls down: the wheel turns the other way.
    post(unsafe { CGEventCreateScrollWheelEvent2(source(), PIXEL_UNITS, 2, -dy.round() as i32, -dx.round() as i32, 0) })
}

/// Type text as it is, a few characters at a time; a newline is Return. Stops when the user takes over.
pub fn type_text(text: &str) -> Result<(), String> {
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            key(36, 0)?;
        }
        let units: Vec<u16> = line.encode_utf16().collect();
        for chunk in units.chunks(16) {
            if user_active() {
                return Err(USER_TOOK_OVER.into());
            }
            for down in [true, false] {
                let e = unsafe { CGEventCreateKeyboardEvent(source(), 0, down) };
                if !e.is_null() {
                    unsafe { CGEventKeyboardSetUnicodeString(e, chunk.len(), chunk.as_ptr()) };
                }
                post(e)?;
            }
        }
    }
    Ok(())
}

/// Press one key with modifier flags held.
pub fn key(code: u16, flags: u64) -> Result<(), String> {
    for down in [true, false] {
        let e = unsafe { CGEventCreateKeyboardEvent(source(), code, down) };
        if !e.is_null() {
            unsafe { CGEventSetFlags(e, flags) };
        }
        post(e)?;
    }
    Ok(())
}

/// "cmd+shift+4", "return", "ctrl+c" → the key's code and the modifier flags (US layout).
pub fn chord(keys: &str) -> Result<(u16, u64), String> {
    let mut flags = 0u64;
    let mut code = None;
    for part in keys.split('+').map(|p| p.trim().to_lowercase()).filter(|p| !p.is_empty()) {
        match part.as_str() {
            "cmd" | "command" | "meta" | "super" => flags |= 0x0010_0000,
            "shift" => flags |= 0x0002_0000,
            "ctrl" | "control" => flags |= 0x0004_0000,
            "alt" | "opt" | "option" => flags |= 0x0008_0000,
            "fn" => flags |= 0x0080_0000,
            k => {
                if code.is_some() {
                    return Err(format!("\"{keys}\" names more than one key"));
                }
                code = Some(key_code(k).ok_or_else(|| format!("no key called \"{k}\"")).map_err(|e| e.to_string())?);
            }
        }
    }
    code.map(|c| (c, flags)).ok_or_else(|| format!("\"{keys}\" names no key, only modifiers"))
}

fn key_code(k: &str) -> Option<u16> {
    const LETTERS: [u16; 26] = [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6];
    const DIGITS: [u16; 10] = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
    const F: [u16; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
    let mut chars = k.chars();
    if let (Some(c), None) = (chars.next(), chars.clone().next()) {
        if c.is_ascii_lowercase() {
            return Some(LETTERS[(c as u8 - b'a') as usize]);
        }
        if c.is_ascii_digit() {
            return Some(DIGITS[(c as u8 - b'0') as usize]);
        }
    }
    if let Some(n) = k.strip_prefix('f').and_then(|n| n.parse::<usize>().ok()).filter(|n| (1..=12).contains(n)) {
        return Some(F[n - 1]);
    }
    Some(match k {
        "return" | "enter" => 36,
        "tab" => 48,
        "space" => 49,
        "delete" | "backspace" => 51,
        "escape" | "esc" => 53,
        "forwarddelete" | "del" => 117,
        "home" => 115,
        "end" => 119,
        "pageup" => 116,
        "pagedown" => 121,
        "left" => 123,
        "right" => 124,
        "down" => 125,
        "up" => 126,
        "-" | "minus" => 27,
        "=" | "equal" => 24,
        "[" => 33,
        "]" => 30,
        "\\" => 42,
        ";" => 41,
        "'" => 39,
        "," | "comma" => 43,
        "." | "period" => 47,
        "/" | "slash" => 44,
        "`" | "grave" => 50,
        _ => return None,
    })
}

// ── the clipboard ────────────────────────────────────────────────────────

/// The clipboard's text, or its image as PNG.
pub fn clipboard_read() -> (Option<String>, Option<Vec<u8>>) {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF};
    let pb = NSPasteboard::generalPasteboard();
    if let Some(s) = pb.stringForType(unsafe { NSPasteboardTypeString }) {
        return (Some(s.to_string()), None);
    }
    if let Some(d) = pb.dataForType(unsafe { NSPasteboardTypePNG }) {
        return (None, Some(d.to_vec()));
    }
    if let Some(d) = pb.dataForType(unsafe { NSPasteboardTypeTIFF }) {
        return (None, tiff_to_png(&d.to_vec()));
    }
    (None, None)
}

fn tiff_to_png(tiff: &[u8]) -> Option<Vec<u8>> {
    let dir = std::env::temp_dir();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let (src, out) = (dir.join(format!("midna-clip-{stamp}.tiff")), dir.join(format!("midna-clip-{stamp}.png")));
    std::fs::write(&src, tiff).ok()?;
    let ok = Command::new("/usr/bin/sips").args(["-s", "format", "png"]).arg(&src).arg("--out").arg(&out).stdout(std::process::Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    let png = if ok { std::fs::read(&out).ok() } else { None };
    let _ = std::fs::remove_file(&src);
    let _ = std::fs::remove_file(&out);
    png
}

pub fn clipboard_write_text(text: &str) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    if pb.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString }) {
        Ok(())
    } else {
        Err("the clipboard didn't take the text".into())
    }
}

/// An image (PNG, or anything sips reads) onto the clipboard.
pub fn clipboard_write_image(png: &[u8]) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG};
    use objc2_foundation::NSData;
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    if pb.setData_forType(Some(&NSData::with_bytes(png)), unsafe { NSPasteboardTypePNG }) {
        Ok(())
    } else {
        Err("the clipboard didn't take the image".into())
    }
}

/// A file onto the clipboard, as Finder copies one.
pub fn clipboard_write_file(path: &Path) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::{NSString, NSURL};
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let s = url.absoluteString().map(|s| s.to_string()).unwrap_or_default();
    if pb.setString_forType(&NSString::from_str(&s), unsafe { NSPasteboardTypeFileURL }) {
        Ok(())
    } else {
        Err("the clipboard didn't take the file".into())
    }
}
