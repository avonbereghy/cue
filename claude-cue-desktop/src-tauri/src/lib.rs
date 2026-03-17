//! Claude Cue Desktop — Rust backend library.
//!
//! Cross-platform session monitor for Claude Code.
//! All file I/O, JSONL parsing, and timer logic lives here.
//! The React frontend is a pure rendering layer.

pub mod models;
pub mod paths;
pub mod security;
pub mod jsonl_parser;
pub mod session_monitor;
pub mod usage_aggregator;
pub mod settings;
pub mod tray;
pub mod cli;
pub mod env_detect;

use models::{EnrichedSession, Settings, UsageWindow, WindowMetrics};
use session_monitor::SessionMonitorState;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};

/// Application state managed by Tauri.
pub struct AppState {
    pub monitor: Arc<SessionMonitorState>,
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_sessions(state: State<'_, AppState>) -> Vec<EnrichedSession> {
    state.monitor.enriched_sessions.lock().unwrap().clone()
}

#[tauri::command]
fn get_usage_metrics(state: State<'_, AppState>) -> HashMap<String, WindowMetrics> {
    let metrics = state.monitor.usage_metrics.lock().unwrap();
    metrics
        .iter()
        .map(|(window, m)| (window.display_name().to_string(), m.clone()))
        .collect()
}

#[tauri::command]
fn get_settings() -> Settings {
    settings::load_settings()
}

#[tauri::command]
fn update_settings(new_settings: Settings) -> Result<(), String> {
    settings::save_settings(&new_settings)
}

#[tauri::command]
fn detect_environment() -> env_detect::EnvironmentInfo {
    env_detect::detect_environment()
}

#[tauri::command]
fn configure_hooks(hook_path: String) -> Result<(), String> {
    env_detect::configure_hooks(&hook_path)
}

#[tauri::command]
fn approve_permission(session_id: String, request_id: String) -> Result<(), String> {
    log::info!("Permission approved: session={}, request={}", session_id, request_id);
    Ok(()) // Stub — Wave 2 wires to permission_server
}

#[tauri::command]
fn deny_permission(session_id: String, request_id: String) -> Result<(), String> {
    log::info!("Permission denied: session={}, request={}", session_id, request_id);
    Ok(()) // Stub — Wave 2 wires to permission_server
}

#[tauri::command]
fn get_permission_history(session_id: String) -> Vec<models::PermissionLogEntry> {
    log::debug!("Getting permission history for session={}", session_id);
    Vec::new() // Stub — Wave 2 reads from permission_log
}

#[tauri::command]
fn get_token_limit(window: String) -> i64 {
    let w = match window.as_str() {
        "FiveHour" | "fiveHour" | "Session (5hr)" => UsageWindow::FiveHour,
        "Daily" | "daily" | "Today" => UsageWindow::Daily,
        "Weekly" | "weekly" | "This Week" => UsageWindow::Weekly,
        _ => return 0,
    };
    settings::token_limit_for_window(&w)
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
    let monitor_poll = monitor.clone();
    let app_poll = app_handle.clone();

    // Poll sessions.json every 1 second
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(1));
        loop {
            interval.tick().await;
            monitor_poll.poll_status();
            let sessions = monitor_poll.enriched_sessions.lock().unwrap().clone();
            let _ = app_poll.emit("sessions-updated", &sessions);
        }
    });

    // Refresh metrics every 5 seconds
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            monitor.refresh_metrics();
            let usage: HashMap<String, WindowMetrics> = {
                let metrics = monitor.usage_metrics.lock().unwrap();
                metrics
                    .iter()
                    .map(|(w, m)| (w.display_name().to_string(), m.clone()))
                    .collect()
            };
            let _ = app_handle.emit("usage-updated", &usage);
        }
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

    // Custom panic handler that suppresses session data from crash dumps
    std::panic::set_hook(Box::new(|info| {
        // Log panic without potentially sensitive payload data
        let location = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
        log::error!(
            "Panic at {}: application error (details suppressed for privacy)",
            location.unwrap_or_else(|| "unknown".to_string())
        );
    }));

    env_logger::init();
    startup_checks();

    let monitor = Arc::new(SessionMonitorState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState {
            monitor: monitor.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            get_usage_metrics,
            get_settings,
            update_settings,
            get_token_limit,
            detect_environment,
            configure_hooks,
            approve_permission,
            deny_permission,
            get_permission_history,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let monitor_tray = monitor.clone();

            // --- System Tray ---
            setup_tray(&handle, &monitor_tray)?;

            // --- Blink timer (0.5s) ---
            spawn_blink_timer(handle.clone(), monitor_tray.clone());

            // --- Data polling timers ---
            spawn_timers(handle, monitor);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// Tray Setup
// ---------------------------------------------------------------------------

/// Format a descriptive tooltip showing session count and state breakdown.
fn format_tooltip(sessions: &[EnrichedSession]) -> String {
    let count = sessions.len();
    if count == 0 {
        return "Claude Cue: no active sessions".to_string();
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
        "Claude Cue: {} session{} \u{2014} {}",
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
    let sessions = monitor.enriched_sessions.lock().unwrap().clone();
    let png_bytes = tray::render_dot_grid(&sessions, true, 64);
    let icon = tauri::image::Image::from_bytes(&png_bytes)?;

    let menu = build_tray_menu(handle, &sessions)?;

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip(format_tooltip(&sessions))
        .on_menu_event(move |app, event| {
            match event.id().as_ref() {
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
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(handle)?;

    Ok(())
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
            &MenuItemBuilder::with_id(
                format!("session-{}", s.info.id),
                &label,
            )
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

/// Spawn a 0.5s blink timer that updates the tray icon when blinking sessions exist.
fn spawn_blink_timer(handle: AppHandle, monitor: Arc<SessionMonitorState>) {
    let blink_on = Arc::new(Mutex::new(true));

    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(500));
        loop {
            interval.tick().await;

            let sessions = monitor.enriched_sessions.lock().unwrap().clone();
            let has_blinking = sessions
                .iter()
                .any(|s| s.info.state == "working" || s.info.state == "subagent");

            if !has_blinking {
                // No blinking needed — still update icon/menu but skip blink toggle
                update_tray(&handle, &sessions, true);
                continue;
            }

            // Toggle blink phase
            let current = {
                let mut b = blink_on.lock().unwrap();
                *b = !*b;
                *b
            };

            update_tray(&handle, &sessions, current);
        }
    });
}

/// Update the tray icon, tooltip, and menu with current session data.
fn update_tray(handle: &AppHandle, sessions: &[EnrichedSession], blink_on: bool) {
    let png_bytes = tray::render_dot_grid(sessions, blink_on, 64);

    if let Some(tray) = handle.tray_by_id("claude-cue-tray") {
        if let Ok(icon) = tauri::image::Image::from_bytes(&png_bytes) {
            let _ = tray.set_icon(Some(icon));
        }

        let _ = tray.set_tooltip(Some(&format_tooltip(sessions)));

        if let Ok(menu) = build_tray_menu(handle, sessions) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}
