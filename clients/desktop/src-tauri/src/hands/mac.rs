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
    fn CGDisplayPixelsWide(display: u32) -> usize;
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
                scale: unsafe { CGDisplayPixelsWide(id) } as f64 / b.size.width.max(1.0),
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
