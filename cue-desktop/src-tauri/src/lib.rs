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
pub mod logging;
pub mod model_context;
pub mod models;
pub mod notifier;
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
use session_monitor::{LockSafe, SessionMonitorState};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, Theme, WebviewUrl,
};

/// Application state managed by Tauri.
pub struct AppState {
    pub monitor: Arc<SessionMonitorState>,
    /// Decides which session state transitions deserve a native notification.
    /// Holds its own previous-state memory + a cached projection of the user's
    /// notification settings (refreshed by `update_settings`).
    pub notifier: Arc<notifier::Notifier>,
    pub pending_permissions: Arc<permission_server::PendingRequests>,
    pub permission_metadata: Arc<Mutex<HashMap<String, models::PermissionRequest>>>,
    /// Last-known screen rect of the tray icon, captured on every click. Used
    /// to anchor the popover when the user opens it via the global shortcut
    /// before clicking the icon at all.
    pub last_tray_rect: Arc<Mutex<Option<tauri::Rect>>>,
    /// Currently-registered global shortcut string, so we know what to
    /// unregister before applying a new settings value.
    pub registered_shortcut: Arc<Mutex<Option<String>>>,
    /// Auto-fit state for the main dashboard window.
    pub main_autosize: Arc<Mutex<MainAutosize>>,
}

/// Tracks whether the main window still auto-fits its height to the dashboard
/// content. We disable it the moment the user resizes the window themselves so
/// auto-fit never fights a manual size. `last_applied` records the content
/// height (logical px) we last set; the next auto-fit compares the window's
/// current height to it and yields if they no longer match.
pub struct MainAutosize {
    pub enabled: bool,
    pub last_applied: Option<f64>,
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
    .title("Appearance")
    .inner_size(250.0, 500.0)
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
    reveal_main(&app);
    // Tell the dashboard it was opened via "expand" so it can play the
    // bloom-in animation that makes the popover feel like it grew into the
    // full window.
    let _ = app.emit("dashboard-expanded", ());
    Ok(())
}

#[tauri::command]
fn open_settings_from_tray(app: AppHandle) -> Result<(), String> {
    if let Some(popover) = app.get_webview_window("tray-popover") {
        let _ = popover.hide();
    }
    reveal_main(&app);
    let _ = app.emit("navigate-settings", ());
    Ok(())
}

/// Canonical "bring the dashboard to the user" path. Every reopen entry point —
/// the Dock Reopen event, the tray menu, the popover buttons, the global
/// shortcut — funnels through this so they behave identically: a hidden OR
/// minimized window is always shown, de-miniaturized, and focused. Omitting
/// `unminimize()` was why the tray menu "Dashboard..." silently did nothing when
/// the window had been minimized to the Dock.
fn reveal_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn get_sessions(state: State<'_, AppState>) -> Vec<EnrichedSession> {
    state.monitor.enriched_sessions.lock_safe().clone()
}

#[tauri::command]
fn get_settings() -> Settings {
    settings::load_settings()
}

#[tauri::command]
fn update_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    new_settings: Settings,
) -> Result<(), String> {
    // Vibrancy is toggled by the frontend via the set_vibrancy command
    // when the user actively selects a glass theme. We do NOT call
    // toggle_vibrancy here — doing so on every save resets the window
    // theme and causes a white flash.
    settings::save_settings(&new_settings)?;
    apply_visibility_settings(&app, &new_settings);
    apply_shortcut_settings(&app, &new_settings);
    // Keep the notifier's cached preferences in lockstep with disk so the
    // poll loop honors a freshly-toggled notification setting on the next tick.
    state
        .notifier
        .update_settings(notifier::NotificationSettings::from(&new_settings));
    // Keep the poll loop's cached idle auto-hide threshold in lockstep with disk
    // so a freshly-changed value takes effect on the next ~1s tick.
    state
        .monitor
        .set_auto_hide_idle_secs(new_settings.auto_hide_idle_secs);
    // Keep the poll loop's cached Claude projects-dir override in lockstep with
    // disk so a freshly-set path takes effect on the next ~1s tick (empty value
    // normalizes to "auto-detect" inside the setter).
    state
        .monitor
        .set_claude_projects_override(Some(new_settings.claude_config_dir.clone()));
    let _ = app.emit("settings-changed", &new_settings);
    Ok(())
}

/// Result of probing a candidate Claude config directory for the Settings UI.
/// Lets the frontend show "✓ found N sessions" / "⚠ nothing here" feedback as
/// the user edits the override, and surface the auto-detected default as a hint.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDirProbe {
    /// The projects directory that WOULD be monitored for the given input
    /// (`<dir>/projects`, or the auto-detected path when `dir` is blank).
    projects_path: String,
    /// Whether that directory currently exists on disk.
    exists: bool,
    /// Count of session transcripts (`*.jsonl`) one level deep, capped.
    session_count: usize,
    /// True when the count hit the cap, so the UI can render "N+".
    capped: bool,
    /// The auto-detected projects dir (`$CLAUDE_CONFIG_DIR` or `~/.claude`),
    /// shown as the placeholder / "currently using" hint when no override is set.
    auto_detected: String,
}

/// Probe a candidate Claude config directory (the value typed into the Settings
/// override field). Runs only on user edit — never on the poll path — so the
/// bounded directory walk can't stall the UI. The path is the user's own input
/// for their own machine; we list directories and check extensions only (no
/// file-content reads), so no workspace sanitization is required.
#[tauri::command]
fn probe_claude_dir(dir: String) -> ClaudeDirProbe {
    const PROBE_CAP: usize = 200;
    let trimmed = dir.trim();
    let projects = if trimmed.is_empty() {
        paths::claude_projects_path()
    } else {
        paths::claude_projects_path_from_override(trimmed)
    };

    // Sessions live at <projects>/<encoded-workspace>/<id>.jsonl — count
    // transcripts one level deep, bounded so a huge tree can't freeze the UI.
    let mut session_count = 0usize;
    let mut capped = false;
    if let Ok(workspaces) = std::fs::read_dir(&projects) {
        'outer: for ws in workspaces.flatten() {
            if !ws.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(ws.path()) {
                for e in entries.flatten() {
                    if e.path().extension().and_then(|x| x.to_str()) == Some("jsonl") {
                        session_count += 1;
                        if session_count >= PROBE_CAP {
                            capped = true;
                            break 'outer;
                        }
                    }
                }
            }
        }
    }

    ClaudeDirProbe {
        exists: projects.exists(),
        session_count,
        capped,
        projects_path: projects.to_string_lossy().into_owned(),
        auto_detected: paths::claude_projects_path().to_string_lossy().into_owned(),
    }
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
    state.monitor.supplemental.lock_safe().system_memory.clone()
}

#[tauri::command]
fn get_claude_version(state: State<'_, AppState>) -> Option<String> {
    state
        .monitor
        .supplemental
        .lock_safe()
        .claude_version
        .clone()
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

/// Resolve the `cue-hook` script bundled as an app resource. In a packaged
/// build this lives under the platform resource dir; in `tauri dev` it is
/// copied next to the dev binary. The deploy step reads this and copies it to
/// `~/.claude/hooks/cue-hook`.
fn resolve_bundled_hook(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve("cue-hook", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Could not locate the bundled cue-hook script: {e}"))
}

#[tauri::command]
fn configure_hooks(app: AppHandle) -> Result<String, String> {
    let bundled = resolve_bundled_hook(&app)?;
    env_detect::deploy_bundled_hook(&bundled)
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

    if let Some(req) = state.permission_metadata.lock_safe().remove(request_id) {
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

/// Build the `permission-request` frontend event payload from a stored request,
/// computing the tool summary. Shared by the live emit path and
/// `get_pending_permissions` so the two payloads can never drift out of shape —
/// the frontend deserializes both as its `PermissionRequest` type.
fn permission_request_payload(req: &models::PermissionRequest) -> serde_json::Value {
    let summary = summary_formatter::format_tool_summary(&req.tool_name, &req.tool_input);
    serde_json::json!({
        "requestId": req.request_id,
        "sessionId": req.session_id,
        "toolName": req.tool_name,
        "toolInput": req.tool_input,
        "summary": summary,
        "hookEventName": req.hook_event_name,
        "receivedAt": req.received_at,
    })
}

/// Map the request IDs still awaiting a decision to their frontend payloads,
/// skipping any ID whose metadata has already been reaped (defensive: metadata
/// is inserted before the pending slot and removed after it, so this normally
/// maps 1:1). Split out from the command so the mapping is unit-testable
/// without standing up a Tauri `State`.
fn build_pending_permissions(
    pending_ids: &[String],
    metadata: &HashMap<String, models::PermissionRequest>,
) -> Vec<serde_json::Value> {
    pending_ids
        .iter()
        .filter_map(|id| metadata.get(id).map(permission_request_payload))
        .collect()
}

/// Return every permission request currently awaiting a decision, in the same
/// shape as the `permission-request` event.
///
/// Recovery path for the permission-prompt wipe race: the frontend's
/// `sessions-updated` listener can receive a snapshot up to ~1s stale (the
/// Focused-rehydrate and the 1s poll both emit a cached enriched snapshot), so
/// a just-arrived prompt can look like it already left the "waiting" state.
/// Rather than trust that snapshot, the frontend re-syncs against this command
/// and drops a pending entry only when the backend confirms it is no longer
/// pending here.
#[tauri::command]
fn get_pending_permissions(state: State<'_, AppState>) -> Vec<serde_json::Value> {
    // Snapshot the still-pending IDs first (releasing that lock) before taking
    // the metadata lock — never hold both std Mutexes at once.
    let pending_ids = state.pending_permissions.pending_ids();
    let metadata = state.permission_metadata.lock_safe();
    build_pending_permissions(&pending_ids, &metadata)
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
        // Read existing sessions.json, strip old sandbox entries, merge new ones.
        // Bounded read: same untrusted-boundary treatment as every other
        // sessions.json read (a same-uid process could drop a huge file here too).
        const SESSIONS_JSON_MAX_BYTES: u64 = 4 * 1024 * 1024;
        let mut status: serde_json::Value =
            security::read_to_string_bounded(&path, SESSIONS_JSON_MAX_BYTES)
                .ok()
                .and_then(|c| serde_json::from_str(&c).ok())
                .unwrap_or_else(|| serde_json::json!({ "sessions": {} }));

        let map = status["sessions"].as_object_mut().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "Invalid sessions.json")
        })?;

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
        const SESSIONS_JSON_MAX_BYTES: u64 = 4 * 1024 * 1024;
        let mut status: serde_json::Value =
            security::read_to_string_bounded(&path, SESSIONS_JSON_MAX_BYTES)
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

/// Manually tuck a session into the recoverable "Resting" group (the card "X").
/// Stays hidden until the session next does something, then re-surfaces. Takes
/// effect on the next ~1s poll.
#[tauri::command]
fn dismiss_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    validate_alphanumeric_id(&session_id, "session ID")?;
    state.monitor.dismiss_session(&session_id);
    Ok(())
}

/// Bring a resting session back into the main view ("restore" in the Resting
/// group). Overrides the idle auto-hide rule until the session next transitions.
#[tauri::command]
fn restore_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    validate_alphanumeric_id(&session_id, "session ID")?;
    state.monitor.restore_session(&session_id);
    Ok(())
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

/// Map a session's launcher `source` (as recorded by the hook: "vscode",
/// "cursor", terminal names, "claude-desktop", "unknown") to a known editor, as
/// `(macOS application name, cross-platform CLI)`, or `None` to fall back to the
/// OS file manager. The Claude desktop app has no "open this folder" entry point,
/// so "claude-desktop" intentionally falls through to the file manager. Pure so
/// the mapping stays unit-testable; each platform reads only the field it needs.
fn known_editor_for_source(source: Option<&str>) -> Option<(&'static str, &'static str)> {
    match source {
        Some("vscode") => Some(("Visual Studio Code", "code")),
        Some("cursor") => Some(("Cursor", "cursor")),
        _ => None,
    }
}

/// Try to open `path` in the editor that launched the session. Returns `true`
/// only if the editor was actually launched.
///
/// macOS uses `open -a <App>` rather than the `code`/`cursor` CLIs because a
/// Finder/Dock-launched `.app` inherits a minimal PATH (/usr/bin:/bin:…) that
/// does NOT include /usr/local/bin or /opt/homebrew/bin where those CLIs live —
/// so a bare `Command::new("code")` would always ENOENT and silently degrade to
/// the file manager. `open` is always at /usr/bin/open, and we check its exit
/// status because `open -a Missing` runs but exits non-zero.
#[cfg(target_os = "macos")]
fn open_in_editor(source: Option<&str>, path: &str) -> bool {
    let Some((app, _cli)) = known_editor_for_source(source) else {
        return false;
    };
    std::process::Command::new("open")
        .args(["-a", app, path])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Non-macOS: the `code`/`cursor` CLIs are normally on PATH (apt/snap install to
/// /usr/bin; the Windows installer adds them), so spawn directly and treat a
/// failed spawn (missing CLI) as "not opened" so the caller falls back.
#[cfg(not(target_os = "macos"))]
fn open_in_editor(source: Option<&str>, path: &str) -> bool {
    let Some((_app, cli)) = known_editor_for_source(source) else {
        return false;
    };
    std::process::Command::new(cli).arg(path).spawn().is_ok()
}

#[cfg(target_os = "macos")]
fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    // `status()` (not `spawn()`) so the short-lived `open` child is reaped.
    std::process::Command::new("open")
        .arg(path)
        .status()
        .map(|_| ())
        .map_err(|e| format!("Failed to open workspace: {}", e))
}

#[cfg(target_os = "linux")]
fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open workspace: {}", e))
}

#[cfg(target_os = "windows")]
fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open workspace: {}", e))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn reveal_in_file_manager(_path: &str) -> Result<(), String> {
    Err("Opening the workspace is not supported on this platform".to_string())
}

/// Open a session's project. Prefer the editor that launched it (VS Code /
/// Cursor) so the user lands in the same tool they're already working in; fall
/// back to the OS file manager when the launcher was a terminal/unknown or the
/// editor isn't installed. The path is canonicalised the same way as
/// `revive_session`, and we additionally require it be absolute so a stale or
/// relative value (e.g. one beginning with '-') can never be parsed as a flag by
/// the spawned program.
#[tauri::command]
fn open_session_workspace(workspace: String, source: Option<String>) -> Result<(), String> {
    let canonical = security::sanitize_workspace_path(&workspace).map_err(|e| e.to_string())?;
    if !canonical.is_absolute() {
        return Err("Workspace path is not absolute".to_string());
    }
    let path = canonical
        .to_str()
        .ok_or_else(|| "Workspace path is not valid UTF-8".to_string())?;

    if open_in_editor(source.as_deref(), path) {
        return Ok(());
    }
    reveal_in_file_manager(path)
}

/// Try to focus the *exact* terminal tab running a session's Claude process, so
/// clicking one of several cards for the same project lands on the right one.
/// Works for native terminals that expose a per-tab tty over AppleScript
/// (iTerm2, Apple Terminal); editors (VS Code/Cursor) have no such API, so this
/// returns `false` for them and the caller falls back to opening the project.
/// Returns `true` only when it actually focused a specific tab.
#[tauri::command]
fn focus_session_terminal(source: Option<String>, pid: Option<u32>) -> bool {
    focus_terminal_tab(source.as_deref(), pid)
}

#[cfg(target_os = "macos")]
fn tty_for_pid(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-o", "tty=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // ps prints the device name only ("ttys003"); the terminal apps report the
    // full "/dev/ttys003". A detached/no-tty process prints "??" / "-".
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some(format!("/dev/{raw}"))
}

#[cfg(target_os = "macos")]
fn focus_terminal_tab(source: Option<&str>, pid: Option<u32>) -> bool {
    let pid = match pid {
        Some(p) => p,
        None => return false,
    };
    let is_iterm = match source {
        Some("iterm") => true,
        Some("terminal") => false,
        _ => return false, // editors / unknown — caller opens the project instead
    };
    let Some(tty) = tty_for_pid(pid) else {
        return false;
    };
    // Defense-in-depth: tty is machine-derived, but never interpolate anything
    // that isn't a plain /dev/<alnum> device into the AppleScript.
    match tty.strip_prefix("/dev/") {
        Some(rest) if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric()) => {}
        _ => return false,
    }

    let script = if is_iterm {
        format!(
            "tell application \"iTerm2\"\n\
               repeat with w in windows\n\
                 repeat with t in tabs of w\n\
                   repeat with s in sessions of t\n\
                     if (tty of s) is \"{tty}\" then\n\
                       select w\n select t\n select s\n activate\n return \"ok\"\n\
                     end if\n\
                   end repeat\n\
                 end repeat\n\
               end repeat\n\
             end tell\n\
             return \"no\""
        )
    } else {
        format!(
            "tell application \"Terminal\"\n\
               repeat with w in windows\n\
                 repeat with t in tabs of w\n\
                   if (tty of t) is \"{tty}\" then\n\
                     set selected of t to true\n set frontmost of w to true\n activate\n return \"ok\"\n\
                   end if\n\
                 end repeat\n\
               end repeat\n\
             end tell\n\
             return \"no\""
        )
    };

    std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "ok")
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn focus_terminal_tab(_source: Option<&str>, _pid: Option<u32>) -> bool {
    false
}

#[cfg(test)]
mod open_workspace_tests {
    use super::known_editor_for_source;

    #[test]
    fn maps_known_editors() {
        assert_eq!(
            known_editor_for_source(Some("vscode")),
            Some(("Visual Studio Code", "code"))
        );
        assert_eq!(
            known_editor_for_source(Some("cursor")),
            Some(("Cursor", "cursor"))
        );
    }

    #[test]
    fn falls_back_for_terminals_and_unknown() {
        for s in [
            "iterm",
            "terminal",
            "wezterm",
            "tmux",
            "ghostty",
            "claude-desktop",
            "unknown",
            "",
        ] {
            assert_eq!(known_editor_for_source(Some(s)), None, "source {s:?}");
        }
        assert_eq!(known_editor_for_source(None), None);
    }
}

// ---------------------------------------------------------------------------
// Hook Install / Uninstall
// ---------------------------------------------------------------------------

#[tauri::command]
fn install_cue_hooks(app: AppHandle) -> Result<String, String> {
    let bundled = resolve_bundled_hook(&app)?;
    env_detect::deploy_bundled_hook(&bundled)
}

#[tauri::command]
fn uninstall_cue_hooks() -> Result<(), String> {
    env_detect::uninstall_hooks()
}

/// Result of a full uninstall, surfaced to the UI so the user sees exactly
/// what was removed and what (if anything) they still need to do by hand.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UninstallReport {
    hooks_removed: bool,
    hook_script_removed: bool,
    autostart_disabled: bool,
    data_removed: bool,
    app_removed: bool,
    app_path: Option<String>,
    manual_steps: Vec<String>,
    errors: Vec<String>,
}

/// Fully uninstall Cue. Disconnects from Claude Code (strips the hook entries
/// from `settings.json` and deletes the deployed hook script), disables login
/// autostart, removes Cue's local data, and moves the app bundle to the Trash
/// on macOS (other platforms report the manual step for their package manager).
///
/// Best-effort: a failure in any one step is recorded in `errors`/`manual_steps`
/// rather than aborting, so a partially-broken environment still gets cleaned
/// as much as possible. The frontend shows the report and then quits the app.
#[tauri::command]
fn uninstall_cue(app: AppHandle) -> UninstallReport {
    let mut report = UninstallReport::default();
    let home = dirs::home_dir();

    // 1. Remove hook entries from settings.json (also clears sessions.json).
    match env_detect::uninstall_hooks() {
        Ok(()) => report.hooks_removed = true,
        Err(e) => report.errors.push(format!("Hook removal: {e}")),
    }

    // 2. Delete the deployed hook script and any .disabled marker.
    if let Some(hook) = env_detect::deployed_hook_path() {
        let mut ok = true;
        if hook.exists() {
            if let Err(e) = std::fs::remove_file(&hook) {
                ok = false;
                report.errors.push(format!("Hook script: {e}"));
            }
        }
        if let Some(h) = &home {
            let _ = std::fs::remove_file(h.join(".claude/hooks/cue-hook.disabled"));
        }
        report.hook_script_removed = ok;
    }

    // 3. Disable login autostart.
    {
        use tauri_plugin_autostart::ManagerExt;
        let autostart = app.autolaunch();
        match autostart.is_enabled() {
            Ok(true) => match autostart.disable() {
                Ok(()) => report.autostart_disabled = true,
                Err(e) => report.errors.push(format!("Autostart: {e}")),
            },
            // Already disabled (or state unknown) — nothing left to do.
            _ => report.autostart_disabled = true,
        }
    }

    // 4. Remove Cue's local data directories.
    report.data_removed = remove_app_data(&mut report.errors);

    // 5. Remove the app bundle (macOS) or report the manual step.
    remove_app_bundle(&mut report);

    report
}

/// Delete Cue's local data directories (sessions/state, settings, presets).
/// Returns true if every existing directory was removed cleanly.
fn remove_app_data(errors: &mut Vec<String>) -> bool {
    let dirs: Vec<std::path::PathBuf> = [
        paths::sessions_json_path(),
        paths::settings_path(),
        paths::presets_dir(),
    ]
    .iter()
    .filter_map(|p| p.parent().map(|parent| parent.to_path_buf()))
    .collect();
    remove_data_dirs(&dirs, errors)
}

/// Dedup `dirs` and `remove_dir_all` each that exists. Returns false (recording
/// per-dir errors) if any removal failed. Split out from `remove_app_data` so
/// this destructive loop is unit-testable against injected temp dirs without
/// touching the real app-data locations.
fn remove_data_dirs(dirs: &[std::path::PathBuf], errors: &mut Vec<String>) -> bool {
    let mut unique: Vec<&std::path::PathBuf> = dirs.iter().collect();
    unique.sort();
    unique.dedup();

    let mut ok = true;
    for dir in unique {
        if dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(dir) {
                ok = false;
                errors.push(format!("Data dir {}: {e}", dir.display()));
            }
        }
    }
    ok
}

/// Remove the installed application. On macOS the running `.app` bundle is
/// moved to the Trash (reversible). On Windows/Linux self-removal of a packaged
/// install isn't reliable, so we record the manual step instead. When running
/// from a dev build (no `.app` ancestor) we never delete anything.
fn remove_app_bundle(report: &mut UninstallReport) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            report.errors.push(format!("Locate app: {e}"));
            return;
        }
    };

    #[cfg(target_os = "macos")]
    {
        let bundle = exe
            .ancestors()
            .find(|p| p.extension().map(|e| e == "app").unwrap_or(false));
        match bundle {
            Some(b) => {
                report.app_path = Some(b.display().to_string());
                match move_to_trash_macos(b) {
                    Ok(()) => report.app_removed = true,
                    Err(e) => {
                        report.errors.push(format!("Move to Trash: {e}"));
                        report
                            .manual_steps
                            .push(format!("Drag {} to the Trash to finish.", b.display()));
                    }
                }
            }
            None => {
                report.app_path = Some(exe.display().to_string());
                report
                    .manual_steps
                    .push("Running from a dev build — app bundle not removed.".into());
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        report.app_path = Some(exe.display().to_string());
        report.manual_steps.push(
            "Uninstall Cue from Settings → Apps (or the original installer) to remove the app."
                .into(),
        );
    }

    #[cfg(target_os = "linux")]
    {
        report.app_path = Some(exe.display().to_string());
        report.manual_steps.push(
            "Remove the Cue package with your package manager (e.g. `sudo apt remove cue`) \
             or delete the AppImage."
                .into(),
        );
    }
}

/// Move a macOS app bundle to `~/.Trash`, suffixing the name on collision.
/// Uses a same-volume rename (Applications and the Trash share the Data volume
/// on modern macOS), so it is fast and reversible from the Finder.
#[cfg(target_os = "macos")]
fn move_to_trash_macos(bundle: &std::path::Path) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let trash = home.join(".Trash");
    std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;

    let name = bundle
        .file_name()
        .ok_or("Invalid bundle path")?
        .to_string_lossy()
        .to_string();
    let stem = bundle
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.clone());

    let dest = next_trash_name(&trash, &name, &stem, |p| p.exists())?;
    std::fs::rename(bundle, &dest).map_err(|e| e.to_string())
}

/// Pick a destination path in `trash` for a bundle named `name` (file stem
/// `stem`), suffixing " N.app" on collision and bailing after 100 tries. The
/// existence check is injected so the collision loop + bailout are unit-testable
/// without creating real files. (Not macOS-gated so tests run on any host.)
#[cfg(any(target_os = "macos", test))]
fn next_trash_name(
    trash: &std::path::Path,
    name: &str,
    stem: &str,
    exists: impl Fn(&std::path::Path) -> bool,
) -> Result<std::path::PathBuf, String> {
    let mut dest = trash.join(name);
    let mut n = 1;
    while exists(&dest) {
        dest = trash.join(format!("{stem} {n}.app"));
        n += 1;
        if n > 100 {
            return Err("Trash already holds many old copies of Cue".into());
        }
    }
    Ok(dest)
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

    // 2. Python 3 interpreter — the hook is invoked as `<python> <hook> <state>`,
    // so a Python 3 on PATH is what makes the hook runnable on every platform.
    let python = env_detect::find_python();
    checks.push(HookStatusCheck {
        label: "Python 3".into(),
        ok: python.is_some(),
        detail: match &python {
            Some(p) => format!("{}", p.display()),
            None => "python3 not found on PATH".into(),
        },
    });

    // 3. Cue hook script — the deployed copy under ~/.claude/hooks.
    let hook_path = home.join(".claude/hooks/cue-hook");
    let hook_found = Some(&hook_path).filter(|p| p.exists());
    checks.push(HookStatusCheck {
        label: "Cue Hook Script".into(),
        ok: hook_found.is_some(),
        detail: match hook_found {
            Some(p) => format!("{}", p.display()),
            None => "cue-hook not installed — run Configure Hooks".into(),
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

/// Check settings.json for cue-hook registration across all expected events.
/// Returns (registered_count, with_timeout_count, total_expected).
fn check_settings_hooks(settings_path: &std::path::Path) -> (usize, usize, usize) {
    let total = env_detect::HOOK_EVENTS.len();
    const CLAUDE_SETTINGS_MAX_BYTES: u64 = 4 * 1024 * 1024;
    let settings: serde_json::Value =
        // User's own ~/.claude/settings.json — follow a symlink (dotfile managers).
        match security::read_to_string_bounded_follow(settings_path, CLAUDE_SETTINGS_MAX_BYTES)
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

    // Verify and correct file permissions. The permission audit log holds a
    // record of every tool decision, so it gets the same owner-only treatment
    // as sessions.json and settings.json. (verify_file_permissions is a no-op
    // when the file doesn't exist yet, e.g. before the first decision.)
    let _ = security::verify_file_permissions(&paths::sessions_json_path());
    let _ = security::verify_file_permissions(&paths::settings_path());
    if let Ok(log_path) = permission_log::log_path() {
        let _ = security::verify_file_permissions(&log_path);
    }

    // Clean stale temp files
    if let Some(parent) = paths::sessions_json_path().parent() {
        let _ = security::cleanup_stale_tmp_files(parent);
    }
    if let Some(parent) = paths::settings_path().parent() {
        let _ = security::cleanup_stale_tmp_files(parent);
    }
}

/// Spawn background timers for polling and metrics refresh.
fn spawn_timers(
    app_handle: AppHandle,
    monitor: Arc<SessionMonitorState>,
    notifier: Arc<notifier::Notifier>,
) {
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
                m.enriched_sessions.lock_safe().clone()
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
    let notifier_poll = notifier.clone();

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
                m.enriched_sessions.lock_safe().clone()
            })
            .await;
            match result {
                Ok(sessions) => {
                    // Decide + fire native notifications for state transitions
                    // (waiting / error / finished). Runs every tick independent
                    // of the emit-dedup below: the notifier seeds silently on a
                    // session's first sight, so the first poll after launch never
                    // produces a storm. Firing from the backend means the alert
                    // reaches the user even when no window is open.
                    let now_secs = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs_f64())
                        .unwrap_or(0.0);
                    // Is the dashboard up and frontmost? If so, a "finished" ping
                    // is something the user can already see, so it's suppressed
                    // (tunable). is_focused() is false when the window is hidden
                    // or closed — so a backgrounded/absent Cue still notifies.
                    let window_focused = app_poll
                        .get_webview_window("main")
                        .and_then(|w| w.is_focused().ok())
                        .unwrap_or(false);
                    for ev in notifier_poll.diff_and_collect_with_focus(
                        &sessions,
                        now_secs,
                        window_focused,
                    ) {
                        use tauri_plugin_notification::NotificationExt;
                        let builder = app_poll
                            .notification()
                            .builder()
                            .title(&ev.title)
                            .body(&ev.body);
                        // Sound only on the pings that ask you to act (needs-you /
                        // error); a "finished" ping stays silent. Builder is moved
                        // by value, so rebind through the match.
                        let builder = match notifier::sound_name(ev.kind) {
                            Some(sound) => builder.sound(sound),
                            None => builder,
                        };
                        let _ = builder.show();
                    }

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
            m.supplemental.lock_safe().claude_version = version;
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

    // Durable, size-bounded, user-reachable log sink (F-observability-001).
    // Replaces the bare `env_logger::init()`, whose stderr output is discarded
    // for a Finder-launched .app — so state traces and anomalies were unlogged
    // in production.
    logging::init();
    startup_checks();

    let monitor = Arc::new(SessionMonitorState::new());
    let app_notifier = Arc::new(notifier::Notifier::new());
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
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
            notifier: app_notifier.clone(),
            pending_permissions,
            permission_metadata,
            last_tray_rect: Arc::new(Mutex::new(None)),
            registered_shortcut: Arc::new(Mutex::new(None)),
            main_autosize: Arc::new(Mutex::new(MainAutosize {
                enabled: true,
                last_applied: None,
            })),
        })
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            get_settings,
            update_settings,
            probe_claude_dir,
            get_theme,
            detect_environment,
            configure_hooks,
            approve_permission,
            deny_permission,
            get_permission_history,
            get_pending_permissions,
            revive_session,
            dismiss_session,
            restore_session,
            open_session_workspace,
            focus_session_terminal,
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
            set_vibrancy,
            write_sandbox_sessions,
            clear_sandbox_sessions,
            take_window_screenshot,
            get_hook_status,
            install_cue_hooks,
            uninstall_cue_hooks,
            uninstall_cue,
            hide_tray_popover,
            resize_tray_popover,
            resize_main_to_content,
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
                                let sessions = state.monitor.enriched_sessions.lock_safe().clone();
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

            // --- Native macOS app menu ---
            // Without this there is no menu bar, so Cmd-Q/Cmd-,/Cmd-W/Cmd-M do
            // nothing and the app feels un-Mac-like. Quit/Window/Edit use the
            // standard predefined items; Settings (Cmd-,) reuses the same path
            // as the tray. Distinct id ("app-settings") so it never collides
            // with the tray menu's own handler.
            #[cfg(target_os = "macos")]
            {
                let settings_item = MenuItemBuilder::with_id("app-settings", "Settings…")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "Cue")
                    .about(None)
                    .separator()
                    .item(&settings_item)
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .separator()
                    .close_window()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app_handle, event| {
                    if event.id().as_ref() == "app-settings" {
                        reveal_main(app_handle);
                        let _ = app_handle.emit("navigate-settings", ());
                    }
                });
            }

            // --- Notifications: request permission up front so the
            // "a session needs you" alert can fire (best-effort; macOS prompts
            // once). ---
            {
                use tauri_plugin_notification::NotificationExt;
                let _ = handle.notification().request_permission();
            }

            // --- Menu-bar / Dock / login settings ---
            let startup_settings = settings::load_settings();
            apply_visibility_settings(&handle, &startup_settings);
            apply_shortcut_settings(&handle, &startup_settings);

            // Apply the persisted notification preferences before the poll loop
            // starts firing (until now the notifier holds all-on defaults).
            app_notifier.update_settings(notifier::NotificationSettings::from(&startup_settings));
            // Seed the poll loop's idle auto-hide threshold from disk (the state
            // defaults to 15 min until this runs).
            monitor.set_auto_hide_idle_secs(startup_settings.auto_hide_idle_secs);
            // Seed the poll loop's Claude projects-dir override from disk (the
            // state defaults to auto-detect until this runs).
            monitor.set_claude_projects_override(Some(startup_settings.claude_config_dir.clone()));

            // --- Blink timer (0.5s) ---
            spawn_blink_timer(handle.clone(), monitor_tray.clone());

            // --- Data polling timers ---
            spawn_timers(handle.clone(), monitor, app_notifier.clone());

            // --- Permission server (localhost-only HTTP for Claude Code hooks) ---
            // Only start if user has opted in via settings
            let perm_settings = settings::load_settings();
            if perm_settings.permissions_enabled {
                // Provision a fresh per-launch token before opening the socket.
                // The Python hook reads the same file and uses it as the HMAC
                // key over a per-request nonce (the raw token never crosses the
                // wire); the server verifies that MAC and 401s anything else.
                // Without this, any local process winning the loopback bind
                // race could forge `{"behavior":"allow"}` responses to Claude
                // Code prompts.
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // macOS: clicking the Dock icon after the window was closed to the
            // menu bar / tray should reopen and focus the dashboard, instead of
            // doing nothing. `Reopen` fires on dock-icon activation.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                reveal_main(_app_handle);
            }
        });
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

        // Bound concurrent in-flight connections so a local flood of slow or
        // stalled peers can't accumulate unbounded Tokio tasks + file
        // descriptors before each connection's ingest timeout drops it. The
        // real client is the single local Python hook; 32 is far more than
        // legitimate use ever needs. At capacity we drop new connections
        // immediately (the peer can retry) rather than stalling the accept loop.
        const MAX_CONNECTIONS: usize = 32;
        let conn_limit = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));

        loop {
            let (stream, _addr) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => {
                    log::debug!("Accept error: {}", e);
                    continue;
                }
            };

            let permit = match conn_limit.clone().try_acquire_owned() {
                Ok(p) => p,
                Err(_) => {
                    log::debug!(
                        "Permission server at capacity ({} conns); dropping",
                        MAX_CONNECTIONS
                    );
                    drop(stream);
                    continue;
                }
            };

            let app = app_handle.clone();
            let pending = pending.clone();
            let metadata = metadata.clone();
            let token = token.clone();

            tokio::spawn(async move {
                // Hold the permit for the connection's lifetime; releasing it on
                // task end (including on ingest timeout) frees the slot.
                let _permit = permit;
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

    // Overall deadline for ingesting the request (header + body). A fixed
    // deadline — not a per-read timeout — defeats a slowloris that dribbles one
    // byte at a time (which would otherwise keep resetting a per-read timer
    // forever), capping the whole pre-decision phase. The post-auth user
    // decision wait has its own separate 60s timeout downstream.
    let ingest_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);

    // Read until we have the \r\n\r\n header terminator or MAX_HEADER_BYTES.
    // A single `read` is not guaranteed to deliver a full header block; fragmented
    // TCP segments would otherwise silently fail the Host-header parse.
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let header_end;
    loop {
        let mut chunk = [0u8; 4096];
        let got = tokio::time::timeout_at(ingest_deadline, stream.read(&mut chunk)).await??;
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

    let (method, path) = permission_server::request_method_and_path(&header_str);

    // DNS-rebinding defense: only accept requests whose Host header names the
    // loopback address or localhost. A webpage that rebinds attacker.example to
    // 127.0.0.1 would reach the socket, but browsers always send the original
    // hostname in Host:, so this blocks cross-origin loopback abuse.
    // Reject any Origin header too — the legit Python hook sends none.
    let host_ok = permission_server::host_header_ok(&header_str);
    let has_origin = permission_server::has_origin_header(&header_str);
    if !host_ok || has_origin {
        let response = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(response.as_bytes()).await;
        return Ok(());
    }

    // Per-launch mutual-HMAC auth on every mutating endpoint. /health stays
    // open because the only caller is the Python hook's connectivity probe and
    // we want a 200 with no auth to be a definitive "server is up" signal
    // (otherwise diagnostics conflate "Cue is down" with "hook can't read the
    // token file"). Anything that produces a side effect — currently just
    // /permission-request — must present a valid X-Cue-Nonce + X-Cue-Auth pair
    // (see permission_server handshake docs). The raw token is never sent on
    // the wire; we recompute the MAC and constant-time-compare below.
    match (method, path) {
        ("GET", "/health") => {
            let response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
            stream.write_all(response.as_bytes()).await?;
        }
        ("POST", "/permission-request") => {
            // Reject unauthenticated POSTs before allocating any state for
            // them. The hook reads STATUS_DIR/permission-token (0600) on every
            // invocation and proves knowledge of it by HMAC'ing a per-request
            // nonce; we recompute the MAC with the same on-disk token and
            // constant-time-compare. On any missing header / mismatch -> 401
            // and NO prompt (a forger who wins the bind race but can't read the
            // token file must not be able to surface a dialog). The returned
            // nonce is retained so we can sign the response the hook verifies.
            let nonce = match permission_server::verify_request_auth(
                &header_str,
                expected_token.as_str(),
            ) {
                Some(n) => n.to_string(),
                None => {
                    let response =
                        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(response.as_bytes()).await;
                    return Ok(());
                }
            };
            // Parse Content-Length to ensure we have the full body
            let content_length: usize = permission_server::parse_content_length(&header_str);

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
                let extra_n =
                    tokio::time::timeout_at(ingest_deadline, stream.read(&mut extra)).await??;
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

            // Build the frontend event payload before we hand ownership of the
            // request to the metadata map below. Shared with the
            // get_pending_permissions command (permission_request_payload) so
            // the live event and the recovery query can't drift out of shape.
            let frontend_payload = permission_request_payload(&permission_req);

            // F-reliability-007 — insert metadata BEFORE the pending receiver.
            // Previously the order was reversed: a resolve that arrived between
            // the pending-insert and the metadata-insert would find pending
            // populated but metadata empty, silently dropping the audit-log
            // entry. With metadata-first, any resolve that finds pending also
            // finds metadata, so the audit log can't lose decisions.
            metadata
                .lock_safe()
                .insert(request_id.clone(), permission_req);

            // Reserve the pending-request slot. If we're saturated (local
            // DoS flood, or a stuck user with dozens of unresolved prompts),
            // reject with 503 before emitting to the frontend so the UI doesn't
            // get a prompt the backend can't track. Also drop the metadata we
            // just inserted so we don't leak a phantom entry.
            let rx = match pending.insert(&request_id) {
                Some(rx) => rx,
                None => {
                    metadata.lock_safe().remove(&request_id);
                    let response = "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: 17\r\nConnection: close\r\n\r\nToo many requests";
                    let _ = stream.write_all(response.as_bytes()).await;
                    return Ok(());
                }
            };

            // De-dupe with the state-transition notifier: on its next poll it
            // will see this session flip to "waiting" and would fire a generic
            // "needs you" ping — tell it to skip that one, since we fire the more
            // specific "Permission needed" notification right here.
            if let Some(app_state) = app.try_state::<AppState>() {
                app_state.notifier.suppress_next_waiting(&session_id);
            }

            // Native notification so a blocked session reaches the user even
            // when the dashboard is hidden in the tray (the whole point of a
            // menu-bar app). Fired from the backend so it works regardless of
            // whether any window is open. Best-effort.
            {
                use tauri_plugin_notification::NotificationExt;
                let builder = app
                    .notification()
                    .builder()
                    .title(format!("Permission needed · {}", tool_name))
                    .body(&summary);
                // A blocked session is a "needs you" alert — give it the same
                // audible cue as the engine's waiting ping.
                let builder = match notifier::sound_name(notifier::NotificationKind::Waiting) {
                    Some(sound) => builder.sound(sound),
                    None => builder,
                };
                let _ = builder.show();
            }

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
            const PERMISSION_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
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
                    metadata.lock_safe().remove(&request_id);
                    let response = "HTTP/1.1 504 Gateway Timeout\r\nContent-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\n\r\nTimeout";
                    stream.write_all(response.as_bytes()).await?;
                    return Ok(());
                }
            };

            let response_body = match decision {
                models::PermissionDecision::Allow => permission_server::ALLOW_RESPONSE,
                models::PermissionDecision::Deny => permission_server::DENY_RESPONSE,
            };

            // Sign the decision with hex(HMAC-SHA256(token, "resp:"+nonce)) so
            // the hook can authenticate this response before acting on it. A
            // process that couldn't read the token file can't produce a proof
            // the hook will accept, so it can't forge an "allow". Only the 200
            // decision carries a proof; the 4xx/504 arms deliberately don't, so
            // the hook falls back to Claude Code's native prompt on any failure.
            let proof = permission_server::response_proof(expected_token.as_str(), &nonce);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{}: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                permission_server::PROOF_HEADER,
                proof,
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
    // No sessions to draw → fall back to the dot-grid's hollow-ring "no active
    // sessions" placeholder for every style, so the menu bar never shows blank
    // tool space. This is hit at startup (zero sessions) and, with the tray
    // idle timeout, whenever every session has idled out of the icon — the
    // bars/clock renderers draw nothing for an empty list.
    if sessions.is_empty() {
        return tray::render_dot_grid(sessions, blink_on, size);
    }
    match style {
        "clock" => tray::render_clock(sessions, blink_on, size),
        "bars" => tray::render_bar_chart(sessions, tick, size),
        _ => tray::render_dot_grid(sessions, blink_on, size),
    }
}

/// Sessions to surface in the tray. Excludes "ended" (revivable in the main
/// app) AND "resting" (auto-hidden idles + manual dismissals) — neither should
/// clutter the menu-bar dots, the tooltip, the native menu, or the popover. This
/// is the single chokepoint feeding all of those, so filtering here keeps the
/// menu bar in lockstep with the React popover (which filters resting too).
fn tray_active_sessions(sessions: &[EnrichedSession]) -> Vec<EnrichedSession> {
    sessions
        .iter()
        .filter(|s| s.info.state.as_str() != "ended" && !s.resting)
        .cloned()
        .collect()
}

/// How long an `idle` session may sit before it drops off the menu-bar icon.
/// It stays in the tooltip, native menu, popover, and dashboard.
const TRAY_ICON_IDLE_TIMEOUT_SECS: f64 = 120.0;

/// Sessions to draw in the menu-bar ICON. Same as the tray list, minus `idle`
/// sessions quiet for >2 min — keeps the up-top glance tight. Only `idle`
/// times out; active/attention/`done` states always stay.
fn tray_icon_sessions(sessions: &[EnrichedSession]) -> Vec<EnrichedSession> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    sessions
        .iter()
        .filter(|s| {
            !(s.info.state.as_str() == "idle"
                && now - s.info.last_activity > TRAY_ICON_IDLE_TIMEOUT_SECS)
        })
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
    let all_sessions = monitor.enriched_sessions.lock_safe().clone();
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
                    *state.last_tray_rect.lock_safe() = Some(rect);
                }
                show_tray_popover(app, rect);
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "dashboard" => {
                reveal_main(app);
            }
            "settings" => {
                reveal_main(app);
                let _ = app.emit("navigate-settings", ());
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

/// Floor for the popover height (logical px) — large enough to seat the
/// empty-state placeholder and a single session row, small enough that one
/// session reads as a short window rather than a half-empty panel.
const TRAY_POPOVER_MIN_HEIGHT: f64 = 150.0;

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
    // Logical-pixel constants tuned to the tray-popover CSS / layout. ROW_PX
    // tracks the real rendered `.tray-row` height — roughly 80px for a typical
    // row (10+10 padding, the state/name line, context bar, model+prompt line,
    // and inter-row gap) — with a small margin so we err slightly tall. The
    // frontend's exact re-measure then shrinks rather than grows the window,
    // since growing past the screen is the worse failure mode. There is no
    // footer; the header carries the only chrome (Cue label + Expand / menu).
    const HEADER_PX: f64 = 44.0;
    const SHELL_PAD_PX: f64 = 14.0;
    const ROW_PX: f64 = 92.0;
    const EMPTY_PLACEHOLDER_PX: f64 = 100.0;

    if session_count == 0 {
        HEADER_PX + EMPTY_PLACEHOLDER_PX + SHELL_PAD_PX
    } else {
        HEADER_PX + (session_count as f64 * ROW_PX) + SHELL_PAD_PX
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
        // Capture the top-left before resizing. On macOS a raw NSWindow resize
        // can pivot around the bottom-left origin, which would drift the popover
        // away from the tray icon as it grows/shrinks; re-asserting the position
        // pins the top edge so the popover stays anchored under the icon.
        let origin = win.outer_position().ok();
        win.set_size(PhysicalSize::new(cur.width, target_h_phys))
            .map_err(|e| e.to_string())?;
        if let Some(origin) = origin {
            let _ = win.set_position(origin);
        }
    }
    Ok(())
}

/// Max fraction of the monitor height the auto-fitting dashboard may occupy
/// before its session list scrolls instead of growing further.
const MAIN_AUTOFIT_MAX_HEIGHT_FRAC: f64 = 0.85;

/// Floor (logical px) for the auto-fit height. Set generously so a one- or
/// two-session dashboard opens as a comfortably tall window rather than hugging
/// a single card; auto-fit grows from here as more sessions arrive.
const MAIN_AUTOFIT_MIN_HEIGHT: f64 = 560.0;

/// Hard ceiling (logical px) kept below the window's configured maxHeight
/// (tauri.conf.json: 1100, outer) minus the title bar. If auto-fit asked for a
/// height the OS then clamped to maxHeight, the next fit would see the clamped
/// size as a "manual" resize and disable itself — so never request past this.
const MAIN_AUTOFIT_MAX_HEIGHT: f64 = 1050.0;

/// Clamp a desired main-window content height to [floor, min(85% of monitor,
/// maxHeight)], returned in logical pixels. Same shape as `clamp_popover_height`
/// but with the dashboard's own bounds.
fn clamp_main_height(win: &tauri::WebviewWindow, content_h: f64) -> f64 {
    let scale = win.scale_factor().unwrap_or(1.0);
    let monitor_h = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as f64 / scale)
        .unwrap_or(900.0);
    let max_h = (monitor_h * MAIN_AUTOFIT_MAX_HEIGHT_FRAC).floor();
    // Effective ceiling is the monitor fraction bounded to [floor, absolute cap]
    // — the lower bound guards clamp against an inverted range on an implausibly
    // short monitor.
    let upper = max_h.clamp(MAIN_AUTOFIT_MIN_HEIGHT, MAIN_AUTOFIT_MAX_HEIGHT);
    content_h.clamp(MAIN_AUTOFIT_MIN_HEIGHT, upper)
}

/// Tolerance (logical px) for the manual-resize check below. Generous enough to
/// absorb the title bar and rounding, small enough that a real drag is caught.
const MAIN_AUTOFIT_MANUAL_TOLERANCE: f64 = 40.0;

/// Auto-fit the main window's height to the dashboard's content (the session
/// list), clamped to a floor and 85% of the monitor — past that the inner list
/// scrolls. Works in inner (content) sizes so it composes with the title bar,
/// and pins the top-left so the window grows/shrinks downward rather than
/// drifting.
///
/// Yields to a manual resize: if the window's current height no longer matches
/// the height we last applied, the user resized it, so we disable auto-fit for
/// the rest of the session. Checking at fit time (rather than via Resized
/// events) avoids races with the window's own show/restore resizes.
#[tauri::command]
fn resize_main_to_content(app: AppHandle, content_height: f64) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let cur = win.inner_size().map_err(|e| e.to_string())?;

    let Some(state) = app.try_state::<AppState>() else {
        return Ok(());
    };
    let mut a = state.main_autosize.lock_safe();
    if !a.enabled {
        return Ok(());
    }
    // Detect a manual resize since our last auto-fit and yield to it.
    let cur_logical = cur.height as f64 / scale;
    if let Some(last) = a.last_applied {
        if (cur_logical - last).abs() > MAIN_AUTOFIT_MANUAL_TOLERANCE {
            a.enabled = false;
            return Ok(());
        }
    }

    let target_h = clamp_main_height(&win, content_height);
    let target_h_phys = (target_h * scale).round() as u32;
    if cur.height != target_h_phys {
        let origin = win.outer_position().ok();
        win.set_size(PhysicalSize::new(cur.width, target_h_phys))
            .map_err(|e| e.to_string())?;
        if let Some(origin) = origin {
            let _ = win.set_position(origin);
        }
    }
    a.last_applied = Some(target_h);
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
                .lock_safe()
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
        *state.last_tray_rect.lock_safe() = Some(rect);
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
        .and_then(|s| *s.last_tray_rect.lock_safe())
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
    let mut current = state.registered_shortcut.lock_safe();
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

            let all_sessions = monitor.enriched_sessions.lock_safe().clone();
            let sessions = tray_active_sessions(&all_sessions);

            let current = {
                let mut t = tick.lock_safe();
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

/// Cache key for the menu-bar ICON's session set (count + IDs + states). Distinct
/// from `menu_cache_key`: it tracks the idle-filtered icon list and covers up to the
/// bar-chart max (12, vs the menu's 8), so dropping any visible bar — including the
/// 9th–12th — flips the key and forces a re-render within one blink tick.
fn icon_cache_key(sessions: &[EnrichedSession]) -> String {
    let mut key = format!("n{};", sessions.len());
    for s in sessions.iter().take(tray::BAR_CHART_MAX_SESSIONS) {
        key.push_str(&s.info.id);
        key.push(':');
        key.push_str(&s.info.state);
        key.push(',');
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

    // The ICON drops idle sessions quiet for >2 min so the menu bar stays tight.
    // The tooltip + native menu below keep using the full `sessions` list, so
    // those (and the popover/dashboard) still show longer idles.
    let icon_sessions = tray_icon_sessions(sessions);

    // Only fold animation phase into the icon key when it actually affects
    // pixels — otherwise unchanged states would re-render every 250ms.
    let phase_key: String = match style.as_str() {
        "bars" => {
            if has_blinking_state(&icon_sessions) {
                format!("s{}", tick % tray::BAR_SHINE_CYCLE)
            } else {
                "static".to_string()
            }
        }
        _ => {
            if has_blinking_state(&icon_sessions) {
                format!("b{}", blink_on as u8)
            } else {
                "static".to_string()
            }
        }
    };
    let icon_key = format!("{}:{}:{}", icon_cache_key(&icon_sessions), phase_key, style);

    let icon_changed = {
        let last = last_icon_key.lock_safe();
        *last != icon_key
    };

    if let Some(tray) = handle.tray_by_id("cue-tray") {
        // Only render + push a new PNG when the visual state actually changed
        if icon_changed {
            let png_bytes = render_tray_icon(&style, &icon_sessions, blink_on, tick, 44);
            if let Ok(icon) = tauri::image::Image::from_bytes(&png_bytes) {
                let _ = tray.set_icon(Some(icon));
            }
            *last_icon_key.lock_safe() = icon_key;
        }

        // Only rebuild menu when session data actually changes
        let should_rebuild = {
            let last = last_menu_key.lock_safe();
            *last != menu_key
        };

        if should_rebuild {
            let _ = tray.set_tooltip(Some(&format_tooltip(sessions)));

            if let Ok(menu) = build_tray_menu(handle, sessions) {
                let _ = tray.set_menu(Some(menu));
            }

            *last_menu_key.lock_safe() = menu_key;
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — uninstall is destructive (remove_dir_all on user data, trash-move
// of the running app). These cover the pieces that don't need a live AppHandle.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn test_next_trash_name_no_collision() {
        // Nothing in the Trash → keep the original name.
        let got = next_trash_name(Path::new("/T"), "Cue.app", "Cue", |_| false).unwrap();
        assert_eq!(got, PathBuf::from("/T/Cue.app"));
    }

    #[test]
    fn test_next_trash_name_one_collision() {
        // "Cue.app" exists, "Cue 1.app" doesn't.
        let got = next_trash_name(Path::new("/T"), "Cue.app", "Cue", |p| {
            p == Path::new("/T/Cue.app")
        })
        .unwrap();
        assert_eq!(got, PathBuf::from("/T/Cue 1.app"));
    }

    #[test]
    fn test_next_trash_name_bails_after_many_collisions() {
        // Everything collides → bail rather than loop forever.
        let result = next_trash_name(Path::new("/T"), "Cue.app", "Cue", |_| true);
        assert!(result.is_err(), "must bail when the Trash is saturated");
    }

    #[test]
    fn test_remove_data_dirs_removes_seeded_and_skips_missing() {
        let base = std::env::temp_dir().join("cue_test_remove_data_dirs");
        let _ = std::fs::remove_dir_all(&base);
        let a = base.join("Cue");
        let b = base.join("com.cueapp");
        std::fs::create_dir_all(a.join("nested")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("sessions.json"), "{}").unwrap();
        let missing = base.join("never_existed");

        let mut errors = Vec::new();
        // Pass a duplicate to exercise dedup, plus a nonexistent dir.
        let ok = remove_data_dirs(&[a.clone(), a.clone(), b.clone(), missing], &mut errors);

        assert!(ok, "removal of existing dirs should succeed: {errors:?}");
        assert!(errors.is_empty());
        assert!(!a.exists(), "seeded dir not removed");
        assert!(!b.exists(), "seeded dir not removed");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_app_data_parents_are_app_scoped() {
        // F-tests-002 tripwire: remove_app_data calls remove_dir_all on the
        // PARENT of each of these paths. That is only safe while every parent
        // is an app-owned directory. If a future paths.rs edit made one resolve
        // to a shared root (~, Application Support, ~/.config, ~/.local/share),
        // uninstall would delete unrelated data. Pin the invariant here.
        let app_scoped = ["Cue", "com.cueapp", "cue"];
        for path in [
            paths::sessions_json_path(),
            paths::settings_path(),
            paths::presets_dir(),
        ] {
            let parent = path.parent().expect("data path has a parent");
            let leaf = parent
                .file_name()
                .and_then(|n| n.to_str())
                .expect("parent has a name");
            assert!(
                app_scoped.contains(&leaf),
                "remove_app_data would remove_dir_all a non-app-scoped dir: {} (leaf {leaf:?})",
                parent.display()
            );
        }
    }

    fn mk_enriched(id: &str, state: &str, last_activity: f64) -> EnrichedSession {
        let info = crate::models::SessionInfo {
            id: id.to_string(),
            workspace: "/tmp/test-project".to_string(),
            state: state.to_string(),
            last_activity,
            started_at: last_activity - 60.0,
            state_changed_at: None,
            source: None,
            hook_input_tokens: 0,
            hook_output_tokens: 0,
            hook_model: String::new(),
            active_subagents: 0,
            subprocess: None,
            team_name: None,
            agent_name: None,
            pid: None,
            permission_mode: None,
            error_type: None,
            pending_permission: None,
        };
        EnrichedSession::from_info_and_metrics(
            info,
            crate::models::SessionMetrics::default(),
            &crate::models::SupplementalData::default(),
        )
    }

    #[test]
    fn test_tray_icon_sessions_times_out_only_stale_idle() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();

        // 300s > 120s threshold; 30s is under it.
        let sessions = vec![
            mk_enriched("idle-stale", "idle", now - 300.0), // dropped from icon
            mk_enriched("idle-fresh", "idle", now - 30.0),  // kept (under 2 min)
            mk_enriched("done-stale", "done", now - 300.0), // kept (done never times out)
            mk_enriched("working-stale", "working", now - 300.0), // kept (active never times out)
        ];

        let icon: Vec<String> = tray_icon_sessions(&sessions)
            .iter()
            .map(|s| s.info.id.clone())
            .collect();

        assert!(
            !icon.contains(&"idle-stale".to_string()),
            "idle quiet >2 min must drop from the menu-bar icon"
        );
        assert!(
            icon.contains(&"idle-fresh".to_string()),
            "idle under 2 min stays on the icon"
        );
        assert!(
            icon.contains(&"done-stale".to_string()),
            "done never times out — only idle does"
        );
        assert!(
            icon.contains(&"working-stale".to_string()),
            "active states never time out off the icon"
        );
        assert_eq!(icon.len(), 3, "exactly the one stale-idle session drops");

        // The tooltip + native menu path (tray_active_sessions) is unaffected:
        // longer idles still show there (and in the popover/dashboard).
        assert_eq!(
            tray_active_sessions(&sessions).len(),
            4,
            "stale idle stays in the tooltip/menu list"
        );
    }

    #[test]
    fn test_render_tray_icon_empty_uses_ring_placeholder_not_blank() {
        // When every session has idled out (or there are none), the bars/clock
        // renderers draw a blank icon. render_tray_icon must instead fall back
        // to the dot-grid hollow-ring placeholder so the tray is never blank.
        let empty: Vec<EnrichedSession> = Vec::new();
        let ring = tray::render_dot_grid(&empty, true, 44);
        let bars_blank = tray::render_bar_chart(&empty, 0, 44);

        for style in ["bars", "clock", "dots"] {
            let got = render_tray_icon(style, &empty, true, 0, 44);
            assert_eq!(
                got, ring,
                "empty {style} icon must render the hollow-ring placeholder"
            );
        }
        assert_ne!(
            ring, bars_blank,
            "sanity: the ring placeholder differs from the blank bar-chart icon"
        );
    }

    #[test]
    fn test_icon_cache_key_changes_when_a_bar_drops() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let before = vec![
            mk_enriched("a", "working", now),
            mk_enriched("b", "idle", now),
        ];
        let after = vec![mk_enriched("a", "working", now)];
        assert_ne!(
            icon_cache_key(&before),
            icon_cache_key(&after),
            "dropping a bar must flip the icon cache key so the icon re-renders"
        );
    }

    // ── get_pending_permissions mapping ─────────────────────────────────

    fn mk_permission_req(request_id: &str, session_id: &str) -> models::PermissionRequest {
        models::PermissionRequest {
            request_id: request_id.to_string(),
            session_id: session_id.to_string(),
            tool_name: "Bash".to_string(),
            tool_input: serde_json::json!({ "command": "npm install" }),
            hook_event_name: "PermissionRequest".to_string(),
            received_at: 1234.5,
        }
    }

    #[test]
    fn test_build_pending_permissions_empty() {
        // No pending IDs -> empty list, regardless of what metadata holds.
        let mut metadata = HashMap::new();
        metadata.insert("orphan".to_string(), mk_permission_req("orphan", "s1"));
        assert!(build_pending_permissions(&[], &metadata).is_empty());
    }

    #[test]
    fn test_build_pending_permissions_maps_to_event_shape() {
        // A pending ID with metadata maps to the exact `permission-request`
        // event shape the frontend deserializes as `PermissionRequest`.
        let mut metadata = HashMap::new();
        metadata.insert("req-1".to_string(), mk_permission_req("req-1", "sess-a"));

        let out = build_pending_permissions(&["req-1".to_string()], &metadata);
        assert_eq!(out.len(), 1);
        let p = &out[0];
        assert_eq!(p["requestId"], "req-1");
        assert_eq!(p["sessionId"], "sess-a");
        assert_eq!(p["toolName"], "Bash");
        assert_eq!(p["toolInput"]["command"], "npm install");
        assert_eq!(p["hookEventName"], "PermissionRequest");
        assert_eq!(p["receivedAt"], 1234.5);
        // The camelCase summary field is present and computed (not null).
        assert!(p["summary"].is_string());
        // Field set matches the frontend PermissionRequest interface exactly.
        let obj = p.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "hookEventName",
                "receivedAt",
                "requestId",
                "sessionId",
                "summary",
                "toolInput",
                "toolName",
            ]
        );
    }

    #[test]
    fn test_build_pending_permissions_skips_ids_without_metadata() {
        // A pending ID whose metadata was already reaped is skipped, and the
        // rest still map — ordering follows the supplied id slice.
        let mut metadata = HashMap::new();
        metadata.insert("has-meta".to_string(), mk_permission_req("has-meta", "s1"));

        let out =
            build_pending_permissions(&["missing".to_string(), "has-meta".to_string()], &metadata);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["requestId"], "has-meta");
    }
}
