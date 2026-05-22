//! Cue Desktop — Rust backend library.
//!
//! Cross-platform session monitor for Claude Code.
//! All file I/O, JSONL parsing, and timer logic lives here.
//! The React frontend is a pure rendering layer.

pub mod cli;
pub mod config_counter;
pub mod env_detect;
pub mod git_status;
pub mod jsonl_parser;
pub mod model_context;
pub mod models;
pub mod paths;
pub mod permission_log;
pub mod permission_server;
pub mod security;
pub mod session_monitor;
pub mod settings;
pub mod summary_formatter;
pub mod system_info;
pub mod tray;

use models::{EnrichedSession, Settings};
use session_monitor::SessionMonitorState;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, Theme, WebviewUrl,
};

/// Application state managed by Tauri.
pub struct AppState {
    pub monitor: Arc<SessionMonitorState>,
    pub pending_permissions: Arc<permission_server::PendingRequests>,
    pub permission_metadata: Arc<Mutex<HashMap<String, models::PermissionRequest>>>,
    /// Last-known screen rect of the tray icon, captured on every click. Used
    /// to anchor the popover when the user opens it via the global shortcut
    /// before clicking the icon at all.
    pub last_tray_rect: Arc<Mutex<Option<tauri::Rect>>>,
    /// Currently-registered global shortcut string, so we know what to
    /// unregister before applying a new settings value.
    pub registered_shortcut: Arc<Mutex<Option<String>>>,
}

// ---------------------------------------------------------------------------
// System theme detection + native appearance
// ---------------------------------------------------------------------------

/// Force the NSWindow's appearance via NSAppearance API.
/// This is needed because Tauri's `set_theme` doesn't override the title bar
/// when `transparent: true` is set in the window config.
#[cfg(target_os = "macos")]
fn set_native_appearance(window: &tauri::WebviewWindow, dark: bool) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    if let Ok(handle) = window.window_handle() {
        if let RawWindowHandle::AppKit(h) = handle.as_raw() {
            unsafe {
                let ns_view: &objc2::runtime::AnyObject =
                    &*(h.ns_view.as_ptr() as *const objc2::runtime::AnyObject);
                let ns_window: *const objc2::runtime::AnyObject = objc2::msg_send![ns_view, window];
                let appearance_name = if dark {
                    objc2_foundation::NSString::from_str("NSAppearanceNameDarkAqua")
                } else {
                    objc2_foundation::NSString::from_str("NSAppearanceNameAqua")
                };
                let ns_appearance_class = objc2::runtime::AnyClass::get(c"NSAppearance").unwrap();
                let appearance: *const objc2::runtime::AnyObject =
                    objc2::msg_send![ns_appearance_class, appearanceNamed: &*appearance_name];
                let _: () = objc2::msg_send![ns_window, setAppearance: appearance];
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn set_native_appearance(_window: &tauri::WebviewWindow, _dark: bool) {}

/// Toggle whether the app shows up in the macOS Dock. When hidden, the app
/// runs as a menu-bar-only "accessory" — no Dock tile and no main menu bar.
/// `NSApplicationActivationPolicyRegular = 0`, `Accessory = 1`.
#[cfg(target_os = "macos")]
fn set_dock_visible(visible: bool) {
    unsafe {
        let nsapp_class = match objc2::runtime::AnyClass::get(c"NSApplication") {
            Some(c) => c,
            None => return,
        };
        let app: *mut objc2::runtime::AnyObject = objc2::msg_send![nsapp_class, sharedApplication];
        if app.is_null() {
            return;
        }
        let policy: isize = if visible { 0 } else { 1 };
        let _: () = objc2::msg_send![&*app, setActivationPolicy: policy];
    }
}

#[cfg(not(target_os = "macos"))]
fn set_dock_visible(_visible: bool) {}

/// Apply the menu-bar / Dock / login settings to the running app. Idempotent —
/// safe to call on startup and after every settings change.
fn apply_visibility_settings(handle: &AppHandle, settings: &Settings) {
    if let Some(tray) = handle.tray_by_id("cue-tray") {
        let _ = tray.set_visible(settings.show_in_menu_bar);
    }

    set_dock_visible(settings.show_in_dock);

    use tauri_plugin_autostart::ManagerExt;
    let autostart = handle.autolaunch();
    let enabled = autostart.is_enabled().unwrap_or(false);
    if settings.start_at_login && !enabled {
        if let Err(e) = autostart.enable() {
            log::warn!("autostart.enable failed: {}", e);
        }
    } else if !settings.start_at_login && enabled {
        if let Err(e) = autostart.disable() {
            log::warn!("autostart.disable failed: {}", e);
        }
    }
}

/// Detect the macOS system appearance by checking UserDefaults.
/// Returns Theme::Dark if AppleInterfaceStyle is "Dark", otherwise Theme::Light.
#[cfg(target_os = "macos")]
fn detect_system_theme() -> Theme {
    let output = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let style = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if style == "Dark" {
                return Theme::Dark;
            }
        }
        _ => {}
    }
    Theme::Light
}

#[cfg(not(target_os = "macos"))]
fn detect_system_theme() -> Theme {
    // On Linux/Windows, default to dark; Tauri should follow system
    Theme::Dark
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn open_keyboard(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("keyboard") {
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "keyboard",
        WebviewUrl::App("index.html#/keyboard".into()),
    )
    .title("Keyboard")
    .inner_size(240.0, 360.0)
    .resizable(false)
    .always_on_top(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_theme_picker(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("theme-picker") {
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "theme-picker",
        WebviewUrl::App("index.html#/theme-picker".into()),
    )
    .title("Themes")
    .inner_size(240.0, 360.0)
    .resizable(false)
    .always_on_top(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_signal_settings(app: AppHandle) -> Result<(), String> {
    // If window already exists, just focus it
    if let Some(win) = app.get_webview_window("signal-settings") {
        let _ = win.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "signal-settings",
        WebviewUrl::App("index.html#/signal-settings".into()),
    )
    .title("Signal Settings")
    .inner_size(700.0, 600.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_tray_popover(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("tray-popover") {
        let _ = win.hide();
    }
    Ok(())
}

#[tauri::command]
fn open_dashboard_from_tray(app: AppHandle) -> Result<(), String> {
    if let Some(popover) = app.get_webview_window("tray-popover") {
        let _ = popover.hide();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn open_settings_from_tray(app: AppHandle) -> Result<(), String> {
    if let Some(popover) = app.get_webview_window("tray-popover") {
        let _ = popover.hide();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = app.emit("navigate-settings", ());
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn get_sessions(state: State<'_, AppState>) -> Vec<EnrichedSession> {
    state.monitor.enriched_sessions.lock().unwrap().clone()
}

#[tauri::command]
fn get_settings() -> Settings {
    settings::load_settings()
}

#[tauri::command]
fn update_settings(app: tauri::AppHandle, new_settings: Settings) -> Result<(), String> {
    // Vibrancy is toggled by the frontend via the set_vibrancy command
    // when the user actively selects a glass theme. We do NOT call
    // toggle_vibrancy here — doing so on every save resets the window
    // theme and causes a white flash.
    settings::save_settings(&new_settings)?;
    apply_visibility_settings(&app, &new_settings);
    apply_shortcut_settings(&app, &new_settings);
    let _ = app.emit("settings-changed", &new_settings);
    Ok(())
}

#[tauri::command]
fn get_theme() -> String {
    match detect_system_theme() {
        Theme::Light => "light".to_string(),
        Theme::Dark => "dark".to_string(),
        _ => "dark".to_string(),
    }
}

#[tauri::command]
fn get_system_memory(state: State<'_, AppState>) -> models::SystemMemory {
    state
        .monitor
        .supplemental
        .lock()
        .unwrap()
        .system_memory
        .clone()
}

#[tauri::command]
fn get_claude_version(state: State<'_, AppState>) -> Option<String> {
    state
        .monitor
        .supplemental
        .lock()
        .unwrap()
        .claude_version
        .clone()
}

#[tauri::command]
fn set_frameless(window: tauri::Window, frameless: bool) {
    let _ = window.set_decorations(!frameless);
}

#[tauri::command]
fn set_vibrancy(app: tauri::AppHandle, enabled: bool) {
    if let Some(window) = app.get_webview_window("main") {
        toggle_vibrancy(&window, enabled);
    }
}

fn toggle_vibrancy(window: &tauri::WebviewWindow, enabled: bool) {
    log::debug!("toggle_vibrancy called, enabled={}", enabled);

    #[cfg(target_os = "macos")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};

        if let Ok(handle) = window.window_handle() {
            if let RawWindowHandle::AppKit(h) = handle.as_raw() {
                unsafe {
                    let ns_view: &objc2::runtime::AnyObject =
                        &*(h.ns_view.as_ptr() as *const objc2::runtime::AnyObject);
                    let ns_window: *const objc2::runtime::AnyObject =
                        objc2::msg_send![ns_view, window];
                    let ns_window: &objc2::runtime::AnyObject = &*ns_window;

                    if enabled {
                        // Glass always uses dark appearance
                        set_native_appearance(window, true);

                        // Make window non-opaque so vibrancy can blur the desktop
                        let _: () =
                            objc2::msg_send![ns_window, setOpaque: objc2::runtime::Bool::NO];
                        // Dark warm fallback instead of clearColor — during Stage Manager
                        // transitions the vibrancy hasn't composited yet; this color
                        // prevents a pure black flash. Matched to typical warm wallpaper tones.
                        let nscolor_class = objc2::runtime::AnyClass::get(c"NSColor").unwrap();
                        let bg: *const objc2::runtime::AnyObject = objc2::msg_send![
                            nscolor_class, colorWithRed: 0.22_f64, green: 0.18_f64, blue: 0.14_f64, alpha: 1.0_f64
                        ];
                        let _: () = objc2::msg_send![ns_window, setBackgroundColor: bg];

                        // Get the current contentView (contains the webview)
                        let old_content: *mut objc2::runtime::AnyObject =
                            objc2::msg_send![ns_window, contentView];

                        // Check if contentView is already an NSVisualEffectView (re-entry guard)
                        let ve_class =
                            objc2::runtime::AnyClass::get(c"NSVisualEffectView").unwrap();
                        let already: objc2::runtime::Bool =
                            objc2::msg_send![&*old_content, isKindOfClass: ve_class];
                        if already.as_bool() {
                            log::debug!("Already wrapped in NSVisualEffectView, skipping");
                            return;
                        }

                        // Create NSVisualEffectView with the same frame
                        let frame: objc2_foundation::NSRect =
                            objc2::msg_send![&*old_content, frame];
                        let ve_view: *mut objc2::runtime::AnyObject =
                            objc2::msg_send![ve_class, alloc];
                        let ve_view: *mut objc2::runtime::AnyObject =
                            objc2::msg_send![ve_view, initWithFrame: frame];

                        // Material: HudWindow (13) — dark frosted glass
                        let _: () = objc2::msg_send![&*ve_view, setMaterial: 13_isize];
                        // Blending: behindWindow (0) — blurs desktop behind the window
                        let _: () = objc2::msg_send![&*ve_view, setBlendingMode: 0_isize];
                        // State: active (1) — always show vibrancy even when unfocused
                        let _: () = objc2::msg_send![&*ve_view, setState: 1_isize];
                        // Auto-resize with window
                        let _: () = objc2::msg_send![&*ve_view, setAutoresizingMask: 18_usize];

                        // Move the old contentView (webview) into the NSVisualEffectView
                        // First, make the old content resize with its parent
                        let _: () = objc2::msg_send![&*old_content, setAutoresizingMask: 18_usize];
                        let _: () = objc2::msg_send![&*ve_view, addSubview: &*old_content];

                        // Set the NSVisualEffectView as the new contentView
                        let _: () = objc2::msg_send![ns_window, setContentView: &*ve_view];

                        log::debug!("Wrapped contentView in NSVisualEffectView OK");

                        // Now make the WKWebView layer AND its HTML content transparent
                        let w = window.clone();
                        tauri::async_runtime::spawn(async move {
                            for delay_ms in [50, 200, 500, 1000, 2000, 4000] {
                                tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms))
                                    .await;
                                // Make WKWebView layer transparent
                                let _ = w.with_webview(|wv| {
                                    let wkwebview: *mut std::ffi::c_void = wv.inner().cast();
                                    let obj: &objc2::runtime::AnyObject =
                                        &*(wkwebview as *const objc2::runtime::AnyObject);
                                    let sel = objc2::sel!(_setDrawsBackground:);
                                    let _: () = objc2::runtime::MessageReceiver::send_message(
                                        obj,
                                        sel,
                                        (objc2::runtime::Bool::NO,),
                                    );
                                });
                                // Force CSS backgrounds transparent via JS injection
                                let _ = w.eval(
                                    "document.documentElement.style.setProperty('--app-bg','transparent');\
                                     document.documentElement.style.background='transparent';\
                                     document.body.style.background='transparent';"
                                );
                                log::debug!("  applied transparency at {}ms", delay_ms);
                            }
                        });
                    } else {
                        // Unwrap: if contentView is NSVisualEffectView, extract the webview
                        let content: *mut objc2::runtime::AnyObject =
                            objc2::msg_send![ns_window, contentView];
                        let ve_class =
                            objc2::runtime::AnyClass::get(c"NSVisualEffectView").unwrap();
                        let is_ve: objc2::runtime::Bool =
                            objc2::msg_send![&*content, isKindOfClass: ve_class];
                        if is_ve.as_bool() {
                            // Get the first subview (the original contentView/webview)
                            let subviews: *const objc2::runtime::AnyObject =
                                objc2::msg_send![&*content, subviews];
                            let count: usize = objc2::msg_send![subviews, count];
                            if count > 0 {
                                let original: *mut objc2::runtime::AnyObject =
                                    objc2::msg_send![subviews, objectAtIndex: 0_usize];
                                let _: () = objc2::msg_send![&*original, removeFromSuperview];
                                let _: () = objc2::msg_send![ns_window, setContentView: &*original];
                            }
                        }
                        // Restore opaque window
                        let _: () =
                            objc2::msg_send![ns_window, setOpaque: objc2::runtime::Bool::YES];
                        let nscolor_class = objc2::runtime::AnyClass::get(c"NSColor").unwrap();
                        let dark_color: *const objc2::runtime::AnyObject =
                            objc2::msg_send![nscolor_class, windowBackgroundColor];
                        let _: () = objc2::msg_send![ns_window, setBackgroundColor: dark_color];

                        // Re-enable WKWebView background drawing
                        let _ = window.with_webview(|wv| {
                            let wkwebview: *mut std::ffi::c_void = wv.inner().cast();
                            let obj: &objc2::runtime::AnyObject =
                                &*(wkwebview as *const objc2::runtime::AnyObject);
                            let sel = objc2::sel!(_setDrawsBackground:);
                            let _: () = objc2::runtime::MessageReceiver::send_message(
                                obj,
                                sel,
                                (objc2::runtime::Bool::YES,),
                            );
                        });

                        // Clear the inline styles that glass mode injected — without this,
                        // `background: transparent` stays on html/body and --app-bg stays
                        // transparent, making the white WKWebView background show through.
                        let _ = window.eval(
                            "document.documentElement.style.removeProperty('background');\
                             document.documentElement.style.removeProperty('--app-bg');\
                             document.body.style.removeProperty('background');",
                        );

                        // Re-apply saved theme to fix title bar appearance.
                        // Use the user's saved preference (resolved through "auto")
                        // instead of forcing the system theme, which would override
                        // a user who explicitly chose dark/light.
                        let s = settings::load_settings();
                        let effective_dark = if s.theme == "light" {
                            false
                        } else if s.theme == "dark" {
                            true
                        } else {
                            // "auto" — follow system
                            detect_system_theme() == Theme::Dark
                        };
                        set_native_appearance(window, effective_dark);

                        log::debug!("Vibrancy cleared, contentView restored");
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
        log::debug!("Vibrancy not supported on this platform");
    }
}

#[tauri::command]
fn detect_environment() -> env_detect::EnvironmentInfo {
    env_detect::detect_environment()
}

#[tauri::command]
fn configure_hooks(hook_path: String) -> Result<(), String> {
    env_detect::configure_hooks(&hook_path)
}

fn record_permission_decision(
    state: &State<'_, AppState>,
    session_id: &str,
    request_id: &str,
    decision: models::PermissionDecision,
    label: &str,
) -> Result<(), String> {
    log::info!(
        "Permission {}: session={}, request={}",
        label.to_lowercase(),
        session_id,
        request_id
    );
    state.pending_permissions.resolve(request_id, decision)?;

    if let Some(req) = state.permission_metadata.lock().unwrap().remove(request_id) {
        let summary = summary_formatter::format_tool_summary(&req.tool_name, &req.tool_input);
        let entry = models::PermissionLogEntry {
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
            session_id: req.session_id,
            tool_name: req.tool_name,
            tool_input_summary: summary,
            decision: label.to_string(),
        };
        let _ = permission_log::append_permission_log(&entry);
    }
    Ok(())
}

#[tauri::command]
fn approve_permission(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
) -> Result<(), String> {
    record_permission_decision(
        &state,
        &session_id,
        &request_id,
        models::PermissionDecision::Allow,
        "Allow",
    )
}

#[tauri::command]
fn deny_permission(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
) -> Result<(), String> {
    record_permission_decision(
        &state,
        &session_id,
        &request_id,
        models::PermissionDecision::Deny,
        "Deny",
    )
}

#[tauri::command]
fn get_permission_history(session_id: String) -> Vec<models::PermissionLogEntry> {
    log::debug!("Getting permission history for session={}", session_id);
    permission_log::read_permission_log(&session_id)
}

/// Minimal session payload written by sandbox mode into sessions.json.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SandboxSessionPayload {
    id: String,
    workspace: String,
    state: String,
    last_activity: f64,
    started_at: f64,
    active_subagents: Option<i64>,
    source: Option<String>,
}

/// Write sandbox sessions into sessions.json alongside real sessions.
/// Sandbox IDs must start with "sandbox-" to be distinguishable.
/// Called by the frontend whenever the sandbox session list changes.
#[tauri::command]
fn write_sandbox_sessions(sessions: Vec<SandboxSessionPayload>) -> Result<(), String> {
    let path = paths::sessions_json_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Validate all IDs start with "sandbox-" AND the rest of the id passes
    // the same regex the hook enforces. Without the second check, an id
    // like "sandbox-../passwd" would slip through the prefix gate but then
    // be silently dropped by the hook's _validate_sessions on the next
    // event — visible state loss with no UI signal. F-correctness-002.
    for s in &sessions {
        let suffix = match s.id.strip_prefix("sandbox-") {
            Some(rest) => rest,
            None => {
                return Err(format!(
                    "Sandbox session ID must start with 'sandbox-': {}",
                    s.id
                ));
            }
        };
        if suffix.is_empty() {
            return Err("Sandbox session ID needs content after 'sandbox-'".into());
        }
        // validate_session_id checks the whole id; the prefix uses '-' which
        // is in the allowlist, so passing the full id (not just suffix) is
        // semantically equivalent and avoids re-validating just the suffix.
        security::validate_session_id(&s.id).map_err(|e| e.to_string())?;
        security::sanitize_workspace_path(&s.workspace).map_err(|e| e.to_string())?;
    }

    // Acquire the cross-process lock the Python hook uses for sessions.json
    // — without it, a hook event firing between our read and our rename
    // silently overwrites the hook's update. F-correctness-002.
    let lock_path = paths::sessions_lock_path();
    security::with_sessions_lock(&lock_path, || {
        // Read existing sessions.json, strip old sandbox entries, merge new ones
        let mut status: serde_json::Value = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_else(|| serde_json::json!({ "sessions": {} }));

        let map = status["sessions"]
            .as_object_mut()
            .ok_or_else(|| std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid sessions.json",
            ))?;

        // Remove stale sandbox entries
        map.retain(|k, _| !k.starts_with("sandbox-"));

        // Insert new sandbox entries
        for s in &sessions {
            let entry = serde_json::json!({
                "id": s.id,
                "workspace": s.workspace,
                "state": s.state,
                "lastActivity": s.last_activity,
                "startedAt": s.started_at,
                "activeSubagents": s.active_subagents.unwrap_or(0),
                "source": s.source.clone().unwrap_or_else(|| "sandbox".to_string()),
            });
            map.insert(s.id.clone(), entry);
        }

        let bytes = serde_json::to_string_pretty(&status)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        security::atomic_write(&path, bytes.as_bytes())
    })
    .map_err(|e| e.to_string())
}

/// Remove all sandbox sessions from sessions.json. Called on sandbox exit.
#[tauri::command]
fn clear_sandbox_sessions() -> Result<(), String> {
    let path = paths::sessions_json_path();
    if !path.exists() {
        return Ok(());
    }

    let lock_path = paths::sessions_lock_path();
    security::with_sessions_lock(&lock_path, || {
        let mut status: serde_json::Value = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_else(|| serde_json::json!({ "sessions": {} }));

        if let Some(map) = status["sessions"].as_object_mut() {
            map.retain(|k, _| !k.starts_with("sandbox-"));
        }

        let bytes = serde_json::to_string_pretty(&status)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        security::atomic_write(&path, bytes.as_bytes())
    })
    .map_err(|e| e.to_string())
}

/// Capture the main window to ~/Desktop/Cue-<timestamp>.png using screencapture.
/// Returns the saved file path on success.
/// Uses logical coordinates (points) as required by screencapture -R.
#[cfg(target_os = "macos")]
#[tauri::command]
fn take_window_screenshot(app: AppHandle) -> Result<String, String> {
    let window = app.get_webview_window("main").ok_or("No main window")?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(format!("Invalid scale factor: {}", scale));
    }

    let lx = (pos.x as f64 / scale).round() as i32;
    let ly = (pos.y as f64 / scale).round() as i32;
    let lw = (size.width as f64 / scale).round() as u32;
    let lh = (size.height as f64 / scale).round() as u32;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let dest = format!(
        "{}/Desktop/Cue-{}.png",
        dirs::home_dir().ok_or("No home dir")?.to_string_lossy(),
        ts
    );

    let status = std::process::Command::new("screencapture")
        .args([
            "-x",                                      // no shutter sound
            &format!("-R{},{},{},{}", lx, ly, lw, lh), // region (logical coords)
            &dest,
        ])
        .status()
        .map_err(|e| e.to_string())?;

    if status.success() {
        Ok(dest)
    } else {
        Err("screencapture failed".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn take_window_screenshot(_app: AppHandle) -> Result<String, String> {
    Err("Screenshots only supported on macOS".to_string())
}

/// Reject any identifier containing characters outside [A-Za-z0-9-]. Used for
/// preset IDs and resumed session UUIDs — both flow into filesystem paths.
fn validate_alphanumeric_id(id: &str, label: &str) -> Result<(), String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("Invalid {}", label));
    }
    Ok(())
}

#[tauri::command]
fn revive_session(session_id: String, workspace: String) -> Result<(), String> {
    validate_alphanumeric_id(&session_id, "session ID")?;
    // Use the canonicalised path returned by sanitize_workspace_path rather
    // than the raw frontend string. The sanitiser resolves symlinks and
    // strips traversal components; passing the raw `workspace` re-introduced
    // those properties at the spawn site. Falls back to the raw input only
    // if conversion to UTF-8 fails, which shouldn't happen for a path the
    // sanitiser just returned, but the explicit branch avoids an unwrap.
    let canonical = security::sanitize_workspace_path(&workspace).map_err(|e| e.to_string())?;
    let canonical_str = canonical
        .to_str()
        .map(|s| s.to_string())
        .unwrap_or(workspace);
    spawn_terminal_with_resume(&session_id, &canonical_str)
}

#[tauri::command]
fn save_preset(preset: models::SignalPreset) -> Result<(), String> {
    let dir = paths::presets_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create presets dir: {}", e))?;
    let path = dir.join(format!("{}.json", preset.id));
    let data =
        serde_json::to_vec(&preset).map_err(|e| format!("Failed to serialize preset: {}", e))?;
    security::atomic_write(&path, &data).map_err(|e| format!("Failed to save preset: {}", e))
}

#[tauri::command]
fn list_presets() -> Result<Vec<models::PresetSummary>, String> {
    let dir = paths::presets_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("Failed to read presets dir: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            if let Ok(data) = std::fs::read(&path) {
                if let Ok(preset) = serde_json::from_slice::<models::SignalPreset>(&data) {
                    summaries.push(models::PresetSummary {
                        id: preset.id,
                        name: preset.name,
                        created_at: preset.created_at,
                        duration_secs: preset.duration_secs,
                    });
                }
            }
        }
    }
    summaries.sort_by(|a, b| b.created_at.total_cmp(&a.created_at));
    Ok(summaries)
}

#[tauri::command]
fn load_preset(id: String) -> Result<models::SignalPreset, String> {
    validate_alphanumeric_id(&id, "preset ID")?;
    let path = paths::presets_dir().join(format!("{}.json", id));
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read preset: {}", e))?;
    serde_json::from_slice(&data).map_err(|e| format!("Failed to parse preset: {}", e))
}

#[tauri::command]
fn delete_preset(id: String) -> Result<(), String> {
    validate_alphanumeric_id(&id, "preset ID")?;
    let path = paths::presets_dir().join(format!("{}.json", id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete preset: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn rename_preset(id: String, name: String) -> Result<(), String> {
    validate_alphanumeric_id(&id, "preset ID")?;
    let path = paths::presets_dir().join(format!("{}.json", id));
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read preset: {}", e))?;
    let mut preset: models::SignalPreset =
        serde_json::from_slice(&data).map_err(|e| format!("Failed to parse preset: {}", e))?;
    preset.name = name;
    let updated =
        serde_json::to_vec(&preset).map_err(|e| format!("Failed to serialize preset: {}", e))?;
    security::atomic_write(&path, &updated).map_err(|e| format!("Failed to save preset: {}", e))
}

#[cfg(target_os = "macos")]
fn spawn_terminal_with_resume(session_id: &str, workspace: &str) -> Result<(), String> {
    // Use osascript to open Terminal.app with the resume command.
    // Pass session_id and workspace as separate arguments to avoid shell injection.
    let script = format!(
        "tell application \"Terminal\"\n\
         activate\n\
         do script \"cd \" & quoted form of \"{}\" & \" && claude --resume \" & quoted form of \"{}\"\n\
         end tell",
        workspace, session_id
    );
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn()
        .map_err(|e| format!("Failed to open Terminal: {}", e))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn spawn_terminal_with_resume(session_id: &str, workspace: &str) -> Result<(), String> {
    let cmd = format!(
        "cd '{}' && claude --resume '{}'",
        workspace.replace('\'', "'\\''"),
        session_id.replace('\'', "'\\''")
    );
    // Try common terminal emulators in order of preference
    let terminals = [
        ("x-terminal-emulator", vec!["-e", "bash", "-c"]),
        ("gnome-terminal", vec!["--", "bash", "-c"]),
        ("konsole", vec!["-e", "bash", "-c"]),
        ("xfce4-terminal", vec!["-e", "bash -c"]),
        ("xterm", vec!["-e", "bash", "-c"]),
    ];
    for (term, args) in &terminals {
        let mut command = std::process::Command::new(term);
        for arg in args {
            command.arg(arg);
        }
        command.arg(&cmd);
        if command.spawn().is_ok() {
            return Ok(());
        }
    }
    Err("No supported terminal emulator found".to_string())
}

#[cfg(target_os = "windows")]
fn spawn_terminal_with_resume(session_id: &str, workspace: &str) -> Result<(), String> {
    // session_id is validated as alphanumeric+dash by validate_alphanumeric_id,
    // so it can flow safely through cmd.exe's quoting. workspace is NOT placed
    // on the command line at all — cmd.exe metacharacter handling (^, %, <, >,
    // (, ), !) is too fragile to rely on a string deny-list. Instead we set
    // the working directory at the OS level via Command::current_dir, and
    // `start ""` opens a new console window inheriting that cwd.
    std::process::Command::new("cmd")
        .current_dir(workspace)
        .args(["/c", "start", "", "claude", "--resume", session_id])
        .spawn()
        .map_err(|e| format!("Failed to open terminal: {}", e))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn spawn_terminal_with_resume(_session_id: &str, _workspace: &str) -> Result<(), String> {
    Err("Revive is not supported on this platform".to_string())
}

// ---------------------------------------------------------------------------
// Hook Install / Uninstall
// ---------------------------------------------------------------------------

#[tauri::command]
fn install_cue_hooks() -> Result<(), String> {
    env_detect::install_hooks()
}

#[tauri::command]
fn uninstall_cue_hooks() -> Result<(), String> {
    env_detect::uninstall_hooks()
}

// ---------------------------------------------------------------------------
// Hook Status Diagnostics
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HookStatusCheck {
    label: String,
    ok: bool,
    detail: String,
}

#[tauri::command]
fn get_hook_status() -> Vec<HookStatusCheck> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut checks = Vec::new();

    // 1. Claude Code installed
    let claude_dir = home.join(".claude");
    checks.push(HookStatusCheck {
        label: "Claude Code".into(),
        ok: claude_dir.exists(),
        detail: if claude_dir.exists() {
            "~/.claude found".into()
        } else {
            "~/.claude not found".into()
        },
    });

    // 2. Hook runner
    let runner = home.join(".claude/hooks/hook-runner.sh");
    let runner_ok = runner.exists() && is_executable(&runner);
    checks.push(HookStatusCheck {
        label: "Hook Runner".into(),
        ok: runner_ok,
        detail: if !runner.exists() {
            "~/.claude/hooks/hook-runner.sh not found".into()
        } else if !is_executable(&runner) {
            "hook-runner.sh not executable".into()
        } else {
            "hook-runner.sh OK".into()
        },
    });

    // 3. Cue hook script — check both possible locations
    let hook_paths = [
        home.join(".claude/symphony-root/cue/hooks/cue-hook"),
        home.join(".claude/hooks/cue-hook"),
    ];
    let hook_found = hook_paths.iter().find(|p| p.exists());
    let hook_ok = hook_found.map(|p| is_executable(p)).unwrap_or(false);
    checks.push(HookStatusCheck {
        label: "Cue Hook Script".into(),
        ok: hook_ok,
        detail: match hook_found {
            Some(p) if is_executable(p) => format!("{}", p.display()),
            Some(p) => format!("{} (not executable)", p.display()),
            None => "cue-hook not found".into(),
        },
    });

    // 4. Hook disabled toggle
    let disabled_file = home.join(".claude/hooks/cue-hook.disabled");
    let not_disabled = !disabled_file.exists();
    checks.push(HookStatusCheck {
        label: "Hook Enabled".into(),
        ok: not_disabled,
        detail: if not_disabled {
            "No .disabled file".into()
        } else {
            "cue-hook.disabled exists — hook is OFF".into()
        },
    });

    // 5. sessions.json exists + freshness
    let sessions_path = paths::sessions_json_path();
    let sessions_age = sessions_path
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| std::time::SystemTime::now().duration_since(t).ok())
        .map(|d| d.as_secs());
    let sessions_ok = sessions_age.map(|a| a < 300).unwrap_or(false); // updated in last 5 min
    checks.push(HookStatusCheck {
        label: "sessions.json".into(),
        ok: sessions_ok,
        detail: match sessions_age {
            Some(age) if age < 60 => "Updated just now".into(),
            Some(age) if age < 300 => format!("Updated {}m ago", age / 60),
            Some(age) => format!("Stale — last update {}m ago", age / 60),
            None => "File not found".into(),
        },
    });

    // 6. Settings hooks — check all required events are registered
    let settings_path = home.join(".claude/settings.json");
    let (hooks_registered, hooks_with_timeout, total_expected) =
        check_settings_hooks(&settings_path);
    let hooks_ok = hooks_registered == total_expected;
    let timeouts_ok = hooks_with_timeout == hooks_registered;
    checks.push(HookStatusCheck {
        label: "Hook Events".into(),
        ok: hooks_ok,
        detail: format!("{}/{} events registered", hooks_registered, total_expected),
    });
    checks.push(HookStatusCheck {
        label: "Hook Timeouts".into(),
        ok: timeouts_ok,
        detail: if timeouts_ok {
            format!("All {} hooks have timeouts", hooks_with_timeout)
        } else {
            format!(
                "{}/{} hooks have timeouts",
                hooks_with_timeout, hooks_registered
            )
        },
    });

    checks
}

fn is_executable(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.exists()
    }
}

/// Check settings.json for cue-hook registration across all expected events.
/// Returns (registered_count, with_timeout_count, total_expected).
fn check_settings_hooks(settings_path: &std::path::Path) -> (usize, usize, usize) {
    let total = env_detect::HOOK_EVENTS.len();
    let settings: serde_json::Value = match std::fs::read_to_string(settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => v,
        None => return (0, 0, total),
    };

    let hooks = match settings.get("hooks").and_then(|h| h.as_object()) {
        Some(h) => h,
        None => return (0, 0, total),
    };

    let mut registered = 0;
    let mut with_timeout = 0;

    for (event, _state) in env_detect::HOOK_EVENTS {
        if let Some(entries) = hooks.get(*event).and_then(|v| v.as_array()) {
            let has_cue = entries.iter().any(|entry| {
                entry
                    .get("hooks")
                    .and_then(|h| h.as_array())
                    .map(|arr| {
                        arr.iter().any(|h| {
                            h.get("command")
                                .and_then(|c| c.as_str())
                                .map(|c| c.contains("cue-hook"))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            });
            if has_cue {
                registered += 1;
                // Check if any cue-hook entry has a timeout
                let has_timeout = entries.iter().any(|entry| {
                    let is_cue = entry
                        .get("hooks")
                        .and_then(|h| h.as_array())
                        .map(|arr| {
                            arr.iter().any(|h| {
                                h.get("command")
                                    .and_then(|c| c.as_str())
                                    .map(|c| c.contains("cue-hook"))
                                    .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false);
                    is_cue
                        && entry
                            .get("hooks")
                            .and_then(|h| h.as_array())
                            .map(|arr| arr.iter().any(|h| h.get("timeout").is_some()))
                            .unwrap_or(false)
                });
                if has_timeout {
                    with_timeout += 1;
                }
            }
        }
    }

    (registered, with_timeout, total)
}

// ---------------------------------------------------------------------------
// Startup + Timer Setup
// ---------------------------------------------------------------------------

/// Run startup checks: verify file permissions, clean stale temp files, ensure dirs.
fn startup_checks() {
    // Ensure required directories exist
    if let Err(e) = paths::ensure_dirs() {
        log::error!("Failed to create directories: {}", e);
    }

    // Verify and correct file permissions
    let _ = security::verify_file_permissions(&paths::sessions_json_path());
    let _ = security::verify_file_permissions(&paths::settings_path());

    // Clean stale temp files
    if let Some(parent) = paths::sessions_json_path().parent() {
        let _ = security::cleanup_stale_tmp_files(parent);
    }
    if let Some(parent) = paths::settings_path().parent() {
        let _ = security::cleanup_stale_tmp_files(parent);
    }
}

/// Spawn background timers for polling and metrics refresh.
fn spawn_timers(app_handle: AppHandle, monitor: Arc<SessionMonitorState>) {
    // Eager prime on app start: run one full pass (metrics + supplemental +
    // poll_status) before the periodic loops settle in. The 1s interval below
    // ticks immediately too, but this gives us belt-and-suspenders coverage so
    // an initial sessions.json snapshot lands as early as possible — and any
    // sessions that were already running when Cue launched are evaluated by
    // the state-aware filter without waiting on a timer schedule.
    {
        let monitor_prime = monitor.clone();
        let app_prime = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let m = monitor_prime.clone();
            let result = tokio::task::spawn_blocking(move || {
                m.refresh_metrics();
                m.refresh_supplemental();
                m.poll_status();
                m.enriched_sessions.lock().unwrap().clone()
            })
            .await;
            match result {
                Ok(sessions) => {
                    let _ = app_prime.emit("sessions-updated", &sessions);
                }
                Err(e) => log::warn!("Eager startup poll failed: {}", e),
            }
        });
    }

    let monitor_poll = monitor.clone();
    let app_poll = app_handle.clone();

    // Poll sessions.json every 1 second.
    //
    // Skip the IPC emit when the serialized payload is byte-identical to the
    // previous tick — at idle that's most ticks, and the frontend re-render
    // still wakes up React's reconciler even though `React.memo` ultimately
    // bails out. Hashing the JSON is far cheaper than crossing the bridge.
    tauri::async_runtime::spawn(async move {
        use std::hash::Hasher;
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(1));
        let mut last_emit_hash: Option<u64> = None;
        loop {
            interval.tick().await;
            let m = monitor_poll.clone();
            let result = tokio::task::spawn_blocking(move || {
                m.poll_status();
                m.enriched_sessions.lock().unwrap().clone()
            })
            .await;
            match result {
                Ok(sessions) => {
                    let payload = match serde_json::to_vec(&sessions) {
                        Ok(b) => b,
                        Err(e) => {
                            log::warn!("Failed to serialize sessions for emit: {}", e);
                            continue;
                        }
                    };
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    hasher.write(&payload);
                    let hash = hasher.finish();
                    if last_emit_hash == Some(hash) {
                        continue;
                    }
                    last_emit_hash = Some(hash);
                    let _ = app_poll.emit("sessions-updated", &sessions);
                }
                Err(e) => log::warn!("poll_status blocking task failed: {}", e),
            }
        }
    });

    // Refresh metrics + supplemental data every 5 seconds
    let monitor_metrics = monitor.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            let m = monitor_metrics.clone();
            let _ = tokio::task::spawn_blocking(move || {
                m.refresh_metrics();
                m.refresh_supplemental();
            })
            .await;
        }
    });

    // Fetch claude --version once at startup (in background)
    tauri::async_runtime::spawn(async move {
        let m = monitor.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let version = system_info::get_claude_version();
            m.supplemental.lock().unwrap().claude_version = version;
        })
        .await;
    });
}

// ---------------------------------------------------------------------------
// Tauri App Builder
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // CLI fallback — handle before any GUI initialization
    if cli::try_run_cli().is_some() {
        std::process::exit(0);
    }

    // Custom panic handler that suppresses session data from crash dumps.
    // Panic payload strings can be built from `format!("... {}", user_data)`
    // or similar and may leak workspace paths, prompts, or assistant text —
    // log location only, never the payload, per CLAUDE.md security rules.
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        log::error!(
            "Panic at {}: application error (details suppressed for privacy)",
            location.unwrap_or_else(|| "unknown".to_string())
        );
    }));

    env_logger::init();
    startup_checks();

    let monitor = Arc::new(SessionMonitorState::new());
    let pending_permissions = Arc::new(permission_server::PendingRequests::new());
    let permission_metadata: Arc<Mutex<HashMap<String, models::PermissionRequest>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let pending_for_server = pending_permissions.clone();
    let metadata_for_server = permission_metadata.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() == ShortcutState::Pressed {
                        toggle_tray_popover_via_shortcut(app);
                    }
                })
                .build(),
        )
        .manage(AppState {
            monitor: monitor.clone(),
            pending_permissions,
            permission_metadata,
            last_tray_rect: Arc::new(Mutex::new(None)),
            registered_shortcut: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            get_settings,
            update_settings,
            get_theme,
            detect_environment,
            configure_hooks,
            approve_permission,
            deny_permission,
            get_permission_history,
            revive_session,
            save_preset,
            list_presets,
            load_preset,
            delete_preset,
            rename_preset,
            open_signal_settings,
            open_keyboard,
            open_theme_picker,
            get_system_memory,
            get_claude_version,
            set_frameless,
            set_vibrancy,
            write_sandbox_sessions,
            clear_sandbox_sessions,
            take_window_screenshot,
            get_hook_status,
            install_cue_hooks,
            uninstall_cue_hooks,
            hide_tray_popover,
            resize_tray_popover,
            open_dashboard_from_tray,
            open_settings_from_tray,
            quit_app,
        ])
        .on_window_event(|window, event| {
            match event {
                // Hide main window instead of quitting — app stays in tray.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        let _ = window.hide();
                        api.prevent_close();
                    } else if window.label() == "tray-popover" {
                        // Tray popover should hide rather than close on Cmd-W etc.
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
                // Emit fresh sessions immediately when window regains focus.
                // macOS throttles WKWebView JS when unfocused, so events/timers
                // stall and the UI appears frozen until this catch-up emit.
                tauri::WindowEvent::Focused(focused) => {
                    if *focused {
                        if window.label() == "main" {
                            if let Some(state) = window.try_state::<AppState>() {
                                let sessions =
                                    state.monitor.enriched_sessions.lock().unwrap().clone();
                                let _ = window.emit("sessions-updated", &sessions);
                            }
                        }
                    } else if window.label() == "tray-popover" {
                        // Click anywhere outside the popover dismisses it.
                        let _ = window.hide();
                    }
                }
                _ => {}
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let monitor_tray = monitor.clone();

            // --- Apply system theme to window ---
            let system_theme = detect_system_theme();
            if let Some(window) = app.get_webview_window("main") {
                // Apply native vibrancy if the saved theme is "glass"
                let s = settings::load_settings();
                let is_glass = s.active_theme_id == "glass";
                toggle_vibrancy(&window, is_glass);

                // Set theme AFTER vibrancy — glass forces dark, others follow system
                let effective_dark = if is_glass {
                    true
                } else {
                    system_theme == Theme::Dark
                };
                set_native_appearance(&window, effective_dark);
            }

            // --- Theme change polling (for "auto" mode) ---
            {
                let theme_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let mut last_theme = tokio::task::spawn_blocking(detect_system_theme)
                        .await
                        .unwrap_or(Theme::Dark);
                    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(2));
                    loop {
                        interval.tick().await;
                        let current = tokio::task::spawn_blocking(detect_system_theme)
                            .await
                            .unwrap_or(last_theme);
                        if current != last_theme {
                            last_theme = current;

                            // Glass theme always stays dark — skip theme switching
                            let s = settings::load_settings();
                            if s.active_theme_id == "glass" {
                                continue;
                            }

                            let theme_str = match current {
                                Theme::Light => "light",
                                Theme::Dark => "dark",
                                _ => "dark",
                            };
                            let _ = theme_handle.emit("system-theme-changed", theme_str);
                            // Also update the webview window theme so CSS media queries work
                            if let Some(w) = theme_handle.get_webview_window("main") {
                                let is_dark = current == Theme::Dark;
                                let handle_clone = theme_handle.clone();
                                let _ = w.run_on_main_thread(move || {
                                    // NSAppearance must be set on the main thread
                                    if let Some(w2) = handle_clone.get_webview_window("main") {
                                        set_native_appearance(&w2, is_dark);
                                    }
                                });
                            }
                        }
                    }
                });
            }

            // --- System Tray ---
            setup_tray(&handle, &monitor_tray)?;

            // --- Menu-bar / Dock / login settings ---
            let startup_settings = settings::load_settings();
            apply_visibility_settings(&handle, &startup_settings);
            apply_shortcut_settings(&handle, &startup_settings);

            // --- Blink timer (0.5s) ---
            spawn_blink_timer(handle.clone(), monitor_tray.clone());

            // --- Data polling timers ---
            spawn_timers(handle.clone(), monitor);

            // --- Permission server (localhost-only HTTP for Claude Code hooks) ---
            // Only start if user has opted in via settings
            let perm_settings = settings::load_settings();
            if perm_settings.permissions_enabled {
                // Provision a fresh per-launch token before opening the socket.
                // The Python hook reads the same file and presents the token in
                // an X-Cue-Token header; the server rejects anything else with
                // 403. Without this, any local process winning the loopback
                // bind race could forge `{"behavior":"allow"}` responses to
                // Claude Code prompts.
                match permission_server::provision_token() {
                    Ok(token) => {
                        spawn_permission_server(
                            handle,
                            pending_for_server,
                            metadata_for_server,
                            token,
                        );
                        log::info!("Permission server started (permissions_enabled=true)");
                    }
                    Err(e) => {
                        log::error!(
                            "Permission server NOT started — failed to provision auth token: {}",
                            e
                        );
                    }
                }
            } else {
                log::info!("Permission server not started (permissions_enabled=false)");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// Permission Server (localhost-only HTTP)
// ---------------------------------------------------------------------------

/// Spawn a localhost TCP server on port 3002 to receive permission requests
/// from Claude Code hooks. Each request blocks until the user approves/denies.
fn spawn_permission_server(
    app_handle: AppHandle,
    pending: Arc<permission_server::PendingRequests>,
    metadata: Arc<Mutex<HashMap<String, models::PermissionRequest>>>,
    token: String,
) {
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:3002").await {
            Ok(l) => l,
            Err(e) => {
                log::warn!("Permission server failed to start: {}", e);
                let _ = app_handle.emit("permission-server-error", e.to_string());
                return;
            }
        };
        log::info!("Permission server listening on 127.0.0.1:3002");

        // Single shared Arc so spawned per-connection tasks compare against
        // the same byte slice without cloning the 32-char string repeatedly.
        let token = Arc::new(token);

        loop {
            let (stream, _addr) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => {
                    log::debug!("Accept error: {}", e);
                    continue;
                }
            };

            let app = app_handle.clone();
            let pending = pending.clone();
            let metadata = metadata.clone();
            let token = token.clone();

            tokio::spawn(async move {
                if let Err(e) =
                    handle_permission_connection(stream, app, pending, metadata, token).await
                {
                    log::debug!("Permission connection error: {}", e);
                }
            });
        }
    });
}

/// Handle a single HTTP connection on the permission server.
async fn handle_permission_connection(
    mut stream: tokio::net::TcpStream,
    app: AppHandle,
    pending: Arc<permission_server::PendingRequests>,
    metadata: Arc<Mutex<HashMap<String, models::PermissionRequest>>>,
    expected_token: Arc<String>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Hard caps — this server talks only to the local Python hook. Anything
    // larger than these bounds is either a bug or a local-DoS attempt.
    const MAX_HEADER_BYTES: usize = 8 * 1024;
    const MAX_BODY_BYTES: usize = 1024 * 1024;

    // Read until we have the \r\n\r\n header terminator or MAX_HEADER_BYTES.
    // A single `read` is not guaranteed to deliver a full header block; fragmented
    // TCP segments would otherwise silently fail the Host-header parse.
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let header_end;
    loop {
        let mut chunk = [0u8; 4096];
        let got = stream.read(&mut chunk).await?;
        if got == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..got]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = pos;
            break;
        }
        if buf.len() > MAX_HEADER_BYTES {
            let response = "HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(response.as_bytes()).await;
            return Ok(());
        }
    }
    let n = buf.len();
    let raw = &buf[..];
    let header_str = String::from_utf8_lossy(&raw[..header_end]);

    let first_line = header_str.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    let method = parts.first().copied().unwrap_or("");
    let path = parts.get(1).copied().unwrap_or("");

    // DNS-rebinding defense: only accept requests whose Host header names the
    // loopback address or localhost. A webpage that rebinds attacker.example to
    // 127.0.0.1 would reach the socket, but browsers always send the original
    // hostname in Host:, so this blocks cross-origin loopback abuse.
    // Reject any Origin header too — the legit Python hook sends none.
    let host_ok = header_str.lines().any(|line| {
        let lower = line.to_lowercase();
        if !lower.starts_with("host:") {
            return false;
        }
        let val = lower.split(':').skip(1).collect::<Vec<_>>().join(":");
        let val = val.trim();
        val.starts_with("127.0.0.1") || val.starts_with("localhost")
    });
    let has_origin = header_str
        .lines()
        .any(|line| line.to_lowercase().starts_with("origin:"));
    if !host_ok || has_origin {
        let response = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(response.as_bytes()).await;
        return Ok(());
    }

    // Per-launch token auth on every mutating endpoint. /health stays open
    // because the only caller is the Python hook's connectivity probe and
    // we want a 200 with no auth to be a definitive "server is up" signal
    // (otherwise diagnostics conflate "Cue is down" with "hook can't read
    // the token file"). Anything that produces a side effect — currently
    // just /permission-request — must present the matching X-Cue-Token
    // header. Header parsing is case-insensitive per RFC 7230 §3.2.
    let token_ok = header_str.lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        if !name.eq_ignore_ascii_case(permission_server::TOKEN_HEADER) {
            return false;
        }
        permission_server::constant_time_eq(value.trim().as_bytes(), expected_token.as_bytes())
    });

    match (method, path) {
        ("GET", "/health") => {
            let response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
            stream.write_all(response.as_bytes()).await?;
        }
        ("POST", "/permission-request") => {
            // Reject unauthenticated POSTs before allocating any state for
            // them. The hook reads STATUS_DIR/permission-token (0600) on
            // every invocation and sends the value verbatim in X-Cue-Token.
            if !token_ok {
                let response = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = stream.write_all(response.as_bytes()).await;
                return Ok(());
            }
            // Parse Content-Length to ensure we have the full body
            let content_length: usize = header_str
                .lines()
                .find_map(|line| {
                    let lower = line.to_lowercase();
                    if lower.starts_with("content-length:") {
                        lower.split(':').nth(1)?.trim().parse().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);

            // Cap body size so a hostile local caller can't claim Content-Length
            // of 4 GB and OOM the process before we even try to read.
            if content_length > MAX_BODY_BYTES {
                let response = "HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = stream.write_all(response.as_bytes()).await;
                return Ok(());
            }

            let body_start = header_end + 4;
            let mut body_bytes: Vec<u8> = if body_start < n {
                raw[body_start..n].to_vec()
            } else {
                Vec::new()
            };

            // Read remaining body if needed
            while body_bytes.len() < content_length {
                let mut extra = vec![0u8; content_length - body_bytes.len()];
                let extra_n = stream.read(&mut extra).await?;
                if extra_n == 0 {
                    break;
                }
                body_bytes.extend_from_slice(&extra[..extra_n]);
            }

            let body_str = String::from_utf8_lossy(&body_bytes);

            // Parse JSON payload
            let payload: serde_json::Value = match serde_json::from_str(&body_str) {
                Ok(v) => v,
                Err(e) => {
                    let msg = format!("Bad JSON: {}", e);
                    let response = format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        msg.len(), msg
                    );
                    stream.write_all(response.as_bytes()).await?;
                    return Ok(());
                }
            };

            // Extract fields from Claude Code hook payload (accept both snake_case and camelCase)
            let session_id = payload
                .get("session_id")
                .or_else(|| payload.get("sessionId"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let tool_name = payload
                .get("tool_name")
                .or_else(|| payload.get("toolName"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let tool_input = payload
                .get("tool_input")
                .or_else(|| payload.get("toolInput"))
                .or_else(|| payload.get("input"))
                .cloned()
                .unwrap_or(serde_json::json!({}));
            let hook_event_name = payload
                .get("hook_event_name")
                .or_else(|| payload.get("hookEventName"))
                .and_then(|v| v.as_str())
                .unwrap_or("PermissionRequest")
                .to_string();

            let request_id = uuid::Uuid::new_v4().to_string();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64();

            let summary = summary_formatter::format_tool_summary(&tool_name, &tool_input);

            let permission_req = models::PermissionRequest {
                request_id: request_id.clone(),
                session_id: session_id.clone(),
                tool_name: tool_name.clone(),
                tool_input: tool_input.clone(),
                hook_event_name: hook_event_name.clone(),
                received_at: now,
            };

            // F-reliability-007 — insert metadata BEFORE the pending receiver.
            // Previously the order was reversed: a resolve that arrived between
            // the pending-insert and the metadata-insert would find pending
            // populated but metadata empty, silently dropping the audit-log
            // entry. With metadata-first, any resolve that finds pending also
            // finds metadata, so the audit log can't lose decisions.
            metadata
                .lock()
                .unwrap()
                .insert(request_id.clone(), permission_req);

            // Reserve the pending-request slot. If we're saturated (local
            // DoS flood, or a stuck user with dozens of unresolved prompts),
            // reject with 503 before emitting to the frontend so the UI doesn't
            // get a prompt the backend can't track. Also drop the metadata we
            // just inserted so we don't leak a phantom entry.
            let rx = match pending.insert(&request_id) {
                Some(rx) => rx,
                None => {
                    metadata.lock().unwrap().remove(&request_id);
                    let response = "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: 12\r\nConnection: close\r\n\r\nToo many requests";
                    let _ = stream.write_all(response.as_bytes()).await;
                    return Ok(());
                }
            };

            // Build frontend event payload (includes computed summary)
            let frontend_payload = serde_json::json!({
                "requestId": request_id,
                "sessionId": session_id,
                "toolName": tool_name,
                "toolInput": tool_input,
                "summary": summary,
                "hookEventName": hook_event_name,
                "receivedAt": now,
            });

            // Emit to React frontend
            let _ = app.emit("permission-request", &frontend_payload);

            // F-reliability-001 — bound the wait at 60s. Without a timeout,
            // an abandoned permission (Claude Code killed mid-prompt, network
            // blip, user closes the toast without clicking) leaks the
            // PendingRequests slot forever. After 64 such leaks, MAX_PENDING
            // saturates and Cue silently stops mediating ALL permissions
            // until the desktop app restarts. 60s is comfortably above any
            // reasonable user-deliberation window for a local UI prompt and
            // well below Python's urlopen 300s ceiling, so the hook still
            // gets a clean 504 well before its own timeout fires.
            const PERMISSION_WAIT_TIMEOUT: std::time::Duration =
                std::time::Duration::from_secs(60);
            let decision = match tokio::time::timeout(PERMISSION_WAIT_TIMEOUT, rx).await {
                Ok(Ok(d)) => d,
                Ok(Err(_)) | Err(_) => {
                    // Either the channel was dropped (cleanup, app shutdown)
                    // or the 60s budget expired. Free BOTH pending and
                    // metadata so a re-fire of the same hook isn't blocked
                    // by a zombie slot, and so subsequent decisions can't
                    // resolve against a stale metadata entry. We use
                    // pending.remove rather than .resolve(Deny) — the wait
                    // was abandoned, not actively denied; the audit log
                    // shouldn't claim the user said no.
                    pending.remove(&request_id);
                    metadata.lock().unwrap().remove(&request_id);
                    let response = "HTTP/1.1 504 Gateway Timeout\r\nContent-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\n\r\nTimeout";
                    stream.write_all(response.as_bytes()).await?;
                    return Ok(());
                }
            };

            let response_body = match decision {
                models::PermissionDecision::Allow => permission_server::ALLOW_RESPONSE,
                models::PermissionDecision::Deny => permission_server::DENY_RESPONSE,
            };

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream.write_all(response.as_bytes()).await?;
        }
        _ => {
            let response = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found";
            stream.write_all(response.as_bytes()).await?;
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tray Setup
// ---------------------------------------------------------------------------

/// Dispatch to the configured menu bar icon renderer.
fn render_tray_icon(
    style: &str,
    sessions: &[EnrichedSession],
    blink_on: bool,
    tick: u32,
    size: u32,
) -> Vec<u8> {
    match style {
        "clock" => tray::render_clock(sessions, blink_on, size),
        "bars" => tray::render_bar_chart(sessions, tick, size),
        _ => tray::render_dot_grid(sessions, blink_on, size),
    }
}

/// Sessions to surface in the tray. Excludes "ended" — those are revivable
/// in the main app and shouldn't clutter the menu bar dots or popover.
fn tray_active_sessions(sessions: &[EnrichedSession]) -> Vec<EnrichedSession> {
    sessions
        .iter()
        .filter(|s| s.info.state.as_str() != "ended")
        .cloned()
        .collect()
}

/// Format a descriptive tooltip showing session count and state breakdown.
fn format_tooltip(sessions: &[EnrichedSession]) -> String {
    let count = sessions.len();
    if count == 0 {
        return "Cue: no active sessions".to_string();
    }

    let mut working = 0u32;
    let mut waiting = 0u32;
    let mut subagent = 0u32;
    let mut error = 0u32;
    let mut idle = 0u32;
    let mut done = 0u32;

    for s in sessions {
        match s.info.state.as_str() {
            "working" => working += 1,
            "waiting" => waiting += 1,
            "subagent" => subagent += 1,
            "error" => error += 1,
            "idle" => idle += 1,
            _ => done += 1,
        }
    }

    let mut parts: Vec<String> = Vec::new();
    if working > 0 {
        parts.push(format!("{} working", working));
    }
    if waiting > 0 {
        parts.push(format!("{} waiting", waiting));
    }
    if subagent > 0 {
        parts.push(format!("{} subagent", subagent));
    }
    if error > 0 {
        parts.push(format!("{} error", error));
    }
    if idle > 0 {
        parts.push(format!("{} idle", idle));
    }
    if done > 0 {
        parts.push(format!("{} done", done));
    }

    format!(
        "Cue: {} session{} \u{2014} {}",
        count,
        if count == 1 { "" } else { "s" },
        parts.join(", ")
    )
}

/// Build the initial system tray icon and menu.
fn setup_tray(
    handle: &AppHandle,
    monitor: &Arc<SessionMonitorState>,
) -> Result<(), Box<dyn std::error::Error>> {
    let all_sessions = monitor.enriched_sessions.lock().unwrap().clone();
    let sessions = tray_active_sessions(&all_sessions);
    let style = settings::load_settings().menu_bar_style;
    let png_bytes = render_tray_icon(&style, &sessions, true, 0, 44);
    let icon = tauri::image::Image::from_bytes(&png_bytes)?;

    let menu = build_tray_menu(handle, &sessions)?;

    TrayIconBuilder::with_id("cue-tray")
        .icon(icon)
        .menu(&menu)
        // Left-click triggers our popover; right-click still gets the native menu.
        .show_menu_on_left_click(false)
        .tooltip(format_tooltip(&sessions))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(state) = app.try_state::<AppState>() {
                    *state.last_tray_rect.lock().unwrap() = Some(rect);
                }
                show_tray_popover(app, rect);
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "dashboard" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app.emit("navigate-settings", ());
                }
            }
            "show-title-bar" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(true);
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app.emit("frameless-changed", false);
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(handle)?;

    Ok(())
}

/// Maximum fraction of the monitor's vertical extent the tray popover may
/// occupy. Past this size the inner list scrolls instead of growing further.
const TRAY_POPOVER_MAX_HEIGHT_FRAC: f64 = 0.80;

/// Floor for the popover height (logical px) — covers the empty-state and
/// keeps a 1-session popover from collapsing into something unusably small.
const TRAY_POPOVER_MIN_HEIGHT: f64 = 200.0;

/// Clamp a desired popover content height against the monitor's available
/// vertical extent. Returned in logical pixels.
fn clamp_popover_height(win: &tauri::WebviewWindow, content_h: f64) -> f64 {
    let scale = win.scale_factor().unwrap_or(1.0);
    let monitor_h = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as f64 / scale)
        .unwrap_or(900.0);
    let max_h = (monitor_h * TRAY_POPOVER_MAX_HEIGHT_FRAC).floor();
    content_h.min(max_h).max(TRAY_POPOVER_MIN_HEIGHT)
}

/// Roughly estimate the popover's natural content height from the visible
/// session count. Used to pre-size the window before showing so the user
/// doesn't see the default 460px shell briefly before the frontend's exact
/// measurement lands.
fn estimate_popover_content_height(session_count: usize) -> f64 {
    // Logical-pixel constants tuned to the tray-popover CSS / layout. We err
    // slightly tall (rather than short) so the frontend's fine-tune resize
    // shrinks rather than grows the window — growing past the screen is the
    // visible failure mode.
    const HEADER_PX: f64 = 44.0;
    const FOOTER_PX: f64 = 60.0;
    const SHELL_PAD_PX: f64 = 14.0;
    const ROW_PX: f64 = 150.0;
    const EMPTY_PLACEHOLDER_PX: f64 = 100.0;

    if session_count == 0 {
        HEADER_PX + EMPTY_PLACEHOLDER_PX + FOOTER_PX + SHELL_PAD_PX
    } else {
        HEADER_PX + (session_count as f64 * ROW_PX) + FOOTER_PX + SHELL_PAD_PX
    }
}

/// Resize the popover to fit the measured content height, capped at 80% of
/// the monitor vertical extent. Called by the frontend after each render so
/// the window stretches/shrinks to match the actual session list — only
/// scrolling once the cap kicks in.
#[tauri::command]
fn resize_tray_popover(app: AppHandle, content_height: f64) -> Result<(), String> {
    let win = app
        .get_webview_window("tray-popover")
        .ok_or_else(|| "tray-popover window not found".to_string())?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let target_h = clamp_popover_height(&win, content_height);
    let target_h_phys = (target_h * scale).round() as u32;
    let cur = win.outer_size().map_err(|e| e.to_string())?;
    if cur.height != target_h_phys {
        win.set_size(PhysicalSize::new(cur.width, target_h_phys))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Position the tray popover under the tray icon and show it. The `rect`
/// from `TrayIconEvent::Click` is the icon's screen rect in physical pixels.
fn show_tray_popover(app: &AppHandle, rect: tauri::Rect) {
    let popover = match app.get_webview_window("tray-popover") {
        Some(w) => w,
        None => return,
    };

    // If already visible, treat the click as toggle-off.
    if let Ok(true) = popover.is_visible() {
        let _ = popover.hide();
        return;
    }

    // Anchor: horizontally centered under the tray icon, with a small gap.
    // `rect` uses the `Position`/`Size` enum (Logical or Physical) — convert
    // both to physical pixels using the popover's scale factor.
    let scale = popover.scale_factor().unwrap_or(1.0);
    let icon_pos = rect.position.to_physical::<f64>(scale);
    let icon_size = rect.size.to_physical::<f64>(scale);

    let icon_center_x = icon_pos.x + (icon_size.width / 2.0);
    let icon_bottom_y = icon_pos.y + icon_size.height;
    let popover_width = popover
        .outer_size()
        .map(|s| s.width as f64)
        .unwrap_or(380.0);

    // Pre-size the window from the current session count so the user doesn't
    // see the default-sized shell briefly. The frontend will fine-tune via
    // `resize_tray_popover` once the DOM has rendered.
    let session_count = app
        .try_state::<AppState>()
        .map(|s| {
            s.monitor
                .enriched_sessions
                .lock()
                .unwrap()
                .iter()
                .filter(|sess| sess.info.state.as_str() != "ended")
                .count()
                .min(12)
        })
        .unwrap_or(0);
    let target_h = clamp_popover_height(&popover, estimate_popover_content_height(session_count));
    let target_h_phys = (target_h * scale).round() as u32;
    let cur_size = popover.outer_size().unwrap_or_default();
    let _ = popover.set_size(PhysicalSize::new(cur_size.width, target_h_phys));

    let target_x = (icon_center_x - popover_width / 2.0).round();
    let target_y = (icon_bottom_y + 6.0).round();

    let _ = popover.set_position(PhysicalPosition::new(target_x, target_y));

    // Match the popover's NSWindow appearance to the user's resolved theme so
    // the system-rendered scrollbars and form controls don't flicker against
    // a mismatched chrome. Resolve the same way main.tsx does: explicit
    // light/dark wins, otherwise follow system.
    #[cfg(target_os = "macos")]
    {
        let s = settings::load_settings();
        let dark = match s.theme.as_str() {
            "light" => false,
            "dark" => true,
            _ => detect_system_theme() == Theme::Dark,
        };
        set_native_appearance(&popover, dark);
    }

    let _ = popover.show();
    let _ = popover.set_focus();
    let _ = app.emit("tray-popover-shown", ());

    // Cache the rect we just used so a subsequent global-shortcut invocation
    // can re-anchor at the same spot without waiting for another click.
    if let Some(state) = app.try_state::<AppState>() {
        *state.last_tray_rect.lock().unwrap() = Some(rect);
    }
}

/// Toggle the tray popover from a global shortcut. If the popover is visible,
/// hide it. Otherwise re-open it at the last-known tray-icon rect, falling
/// back to the top-right of the primary monitor when the user has never
/// clicked the tray icon yet.
fn toggle_tray_popover_via_shortcut(app: &AppHandle) {
    let popover = match app.get_webview_window("tray-popover") {
        Some(w) => w,
        None => return,
    };
    if let Ok(true) = popover.is_visible() {
        let _ = popover.hide();
        return;
    }
    let rect = app
        .try_state::<AppState>()
        .and_then(|s| *s.last_tray_rect.lock().unwrap())
        .unwrap_or_else(|| fallback_tray_rect(&popover));
    show_tray_popover(app, rect);
}

/// Synthesize a tray-icon rect at the top-right of the popover's current
/// monitor. Used when no real click rect has been observed yet — the popover
/// opens just under the menu bar at the right edge, matching where most
/// users keep menu-bar utilities.
fn fallback_tray_rect(popover: &tauri::WebviewWindow) -> tauri::Rect {
    use tauri::{LogicalPosition, LogicalSize};
    let scale = popover.scale_factor().unwrap_or(1.0);
    let monitor_w = popover
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().width as f64 / scale)
        .unwrap_or(1440.0);
    // Tray icons live near the right edge on macOS; 28px in from the right
    // approximates a single-icon offset. Y=2 puts the synthetic icon "bottom"
    // at the menu bar so show_tray_popover's 6px gap leaves it just below.
    tauri::Rect {
        position: LogicalPosition::new(monitor_w - 28.0, 2.0).into(),
        size: LogicalSize::new(24.0, 24.0).into(),
    }
}

/// Apply the user's tray-shortcut settings — unregister any existing
/// shortcut, then register the configured one if `tray_shortcut_enabled`.
/// Idempotent: safe to call on every settings save.
fn apply_shortcut_settings(handle: &AppHandle, settings: &models::Settings) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let state = match handle.try_state::<AppState>() {
        Some(s) => s,
        None => return,
    };
    let gs = handle.global_shortcut();

    // Unregister whatever we had previously, so the new value cleanly replaces it.
    let mut current = state.registered_shortcut.lock().unwrap();
    if let Some(old) = current.take() {
        let _ = gs.unregister(old.as_str());
    }

    if !settings.tray_shortcut_enabled {
        return;
    }
    let raw = settings.tray_shortcut.trim();
    if raw.is_empty() {
        return;
    }
    match gs.register(raw) {
        Ok(()) => {
            *current = Some(raw.to_string());
            log::info!("Registered tray-toggle shortcut: {}", raw);
        }
        Err(e) => {
            log::warn!("Failed to register shortcut '{}': {}", raw, e);
        }
    }
}

/// Build the tray context menu from current session data.
fn build_tray_menu(
    handle: &AppHandle,
    sessions: &[EnrichedSession],
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let mut builder = MenuBuilder::new(handle);

    // Header
    builder = builder.text("header", "Claude Code Sessions");
    builder = builder.separator();

    // Per-session items
    for s in sessions.iter().take(8) {
        let duration = format_duration_short(s.duration_secs);
        let tokens = format_tokens_short(s.metrics.total_tokens());
        let label = format!(
            "{} {} \u{2014} {} \u{2014} {}",
            s.state_icon, s.workspace_name, duration, tokens
        );
        builder = builder.item(
            &MenuItemBuilder::with_id(format!("session-{}", s.info.id), &label)
                .enabled(false)
                .build(handle)?,
        );
    }

    if sessions.is_empty() {
        builder = builder.item(
            &MenuItemBuilder::with_id("no-sessions", "No active sessions")
                .enabled(false)
                .build(handle)?,
        );
    }

    builder = builder.separator();
    builder = builder.text("dashboard", "Dashboard...");
    builder = builder.text("show-title-bar", "Show Title Bar");
    builder = builder.text("settings", "Settings...");
    builder = builder.separator();
    builder = builder.text("quit", "Quit");

    Ok(builder.build()?)
}

fn format_duration_short(secs: f64) -> String {
    let total = secs.max(0.0) as u64;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    if h > 0 {
        format!("{}h {:02}m", h, m)
    } else {
        format!("{}m", m)
    }
}

fn format_tokens_short(tokens: i64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M tok", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("{:.1}K tok", tokens as f64 / 1_000.0)
    } else {
        format!("{} tok", tokens)
    }
}

// ---------------------------------------------------------------------------
// Blink Timer
// ---------------------------------------------------------------------------

/// Spawn the tray animation timer. Fires every 250 ms and increments a
/// monotonic tick counter. The blink phase used by the dot/clock styles
/// derives from this tick (toggling every 2 ticks = 500 ms, matching the
/// historical rate); the bar-chart shine sweep uses the tick directly. The
/// icon-key check inside `update_tray` suppresses re-renders on ticks where
/// nothing about the icon actually changed.
fn spawn_blink_timer(handle: AppHandle, monitor: Arc<SessionMonitorState>) {
    let tick: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let last_menu_key: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let last_icon_key: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(250));
        loop {
            interval.tick().await;

            let all_sessions = monitor.enriched_sessions.lock().unwrap().clone();
            let sessions = tray_active_sessions(&all_sessions);

            let current = {
                let mut t = tick.lock().unwrap();
                *t = t.wrapping_add(1);
                *t
            };

            update_tray(&handle, &sessions, current, &last_menu_key, &last_icon_key);
        }
    });
}

/// Build a cache key representing the menu-relevant session state (IDs + states + names).
/// The menu only needs rebuilding when this changes, NOT on every blink tick.
fn menu_cache_key(sessions: &[EnrichedSession]) -> String {
    let mut key = String::new();
    for (i, s) in sessions.iter().enumerate().take(8) {
        if i > 0 {
            key.push(',');
        }
        key.push_str(&s.info.id);
        key.push(':');
        key.push_str(&s.info.state);
        key.push(':');
        key.push_str(&s.workspace_name);
    }
    key
}

/// Sessions whose colour/alpha changes between the on and off blink phases.
fn has_blinking_state(sessions: &[EnrichedSession]) -> bool {
    sessions.iter().any(|s| {
        matches!(
            s.info.state.as_str(),
            "working" | "thinking" | "subagent" | "compacting" | "clearing"
        )
    })
}

/// Update the tray icon, tooltip, and menu with current session data.
/// The icon is only re-rendered when sessions or animation phase actually
/// changes. The menu is only rebuilt when session data changes (not on
/// animation ticks) to avoid dismissing an open menu on macOS.
fn update_tray(
    handle: &AppHandle,
    sessions: &[EnrichedSession],
    tick: u32,
    last_menu_key: &Arc<Mutex<String>>,
    last_icon_key: &Arc<Mutex<String>>,
) {
    let menu_key = menu_cache_key(sessions);
    let style = settings::load_settings().menu_bar_style;
    // Preserve historical 500ms blink cadence under the 250ms tick.
    let blink_on = (tick / 2).is_multiple_of(2);

    // Only fold animation phase into the icon key when it actually affects
    // pixels — otherwise unchanged states would re-render every 250ms.
    let phase_key: String = match style.as_str() {
        "bars" => {
            if has_blinking_state(sessions) {
                format!("s{}", tick % tray::BAR_SHINE_CYCLE)
            } else {
                "static".to_string()
            }
        }
        _ => {
            if has_blinking_state(sessions) {
                format!("b{}", blink_on as u8)
            } else {
                "static".to_string()
            }
        }
    };
    let icon_key = format!("{}:{}:{}", menu_key, phase_key, style);

    let icon_changed = {
        let last = last_icon_key.lock().unwrap();
        *last != icon_key
    };

    if let Some(tray) = handle.tray_by_id("cue-tray") {
        // Only render + push a new PNG when the visual state actually changed
        if icon_changed {
            let png_bytes = render_tray_icon(&style, sessions, blink_on, tick, 44);
            if let Ok(icon) = tauri::image::Image::from_bytes(&png_bytes) {
                let _ = tray.set_icon(Some(icon));
            }
            *last_icon_key.lock().unwrap() = icon_key;
        }

        // Only rebuild menu when session data actually changes
        let should_rebuild = {
            let last = last_menu_key.lock().unwrap();
            *last != menu_key
        };

        if should_rebuild {
            let _ = tray.set_tooltip(Some(&format_tooltip(sessions)));

            if let Ok(menu) = build_tray_menu(handle, sessions) {
                let _ = tray.set_menu(Some(menu));
            }

            *last_menu_key.lock().unwrap() = menu_key;
        }
    }
}
