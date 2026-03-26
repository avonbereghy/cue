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
pub mod settings;
pub mod tray;
pub mod cli;
pub mod env_detect;
pub mod permission_server;
pub mod permission_log;
pub mod summary_formatter;

use models::{EnrichedSession, Settings};
use session_monitor::SessionMonitorState;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, Theme, WebviewUrl};

/// Application state managed by Tauri.
pub struct AppState {
    pub monitor: Arc<SessionMonitorState>,
    pub pending_permissions: Arc<permission_server::PendingRequests>,
    pub permission_metadata: Arc<Mutex<HashMap<String, models::PermissionRequest>>>,
}

// ---------------------------------------------------------------------------
// System theme detection
// ---------------------------------------------------------------------------

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
    tauri::WebviewWindowBuilder::new(&app, "keyboard", WebviewUrl::App("index.html#/keyboard".into()))
        .title("Keyboard")
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
    tauri::WebviewWindowBuilder::new(&app, "signal-settings", WebviewUrl::App("index.html#/signal-settings".into()))
        .title("Signal Settings")
        .inner_size(700.0, 600.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
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
    settings::save_settings(&new_settings)?;
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
fn detect_environment() -> env_detect::EnvironmentInfo {
    env_detect::detect_environment()
}

#[tauri::command]
fn configure_hooks(hook_path: String) -> Result<(), String> {
    env_detect::configure_hooks(&hook_path)
}

#[tauri::command]
fn approve_permission(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
) -> Result<(), String> {
    log::info!("Permission approved: session={}, request={}", session_id, request_id);
    state.pending_permissions.resolve(&request_id, models::PermissionDecision::Allow)?;

    // Log the decision using stored metadata
    if let Some(req) = state.permission_metadata.lock().unwrap().remove(&request_id) {
        let summary = summary_formatter::format_tool_summary(&req.tool_name, &req.tool_input);
        let entry = models::PermissionLogEntry {
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
            session_id: req.session_id,
            tool_name: req.tool_name,
            tool_input_summary: summary,
            decision: "Allow".to_string(),
        };
        let _ = permission_log::append_permission_log(&entry);
    }

    Ok(())
}

#[tauri::command]
fn deny_permission(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
) -> Result<(), String> {
    log::info!("Permission denied: session={}, request={}", session_id, request_id);
    state.pending_permissions.resolve(&request_id, models::PermissionDecision::Deny)?;

    // Log the decision using stored metadata
    if let Some(req) = state.permission_metadata.lock().unwrap().remove(&request_id) {
        let summary = summary_formatter::format_tool_summary(&req.tool_name, &req.tool_input);
        let entry = models::PermissionLogEntry {
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
            session_id: req.session_id,
            tool_name: req.tool_name,
            tool_input_summary: summary,
            decision: "Deny".to_string(),
        };
        let _ = permission_log::append_permission_log(&entry);
    }

    Ok(())
}

#[tauri::command]
fn get_permission_history(session_id: String) -> Vec<models::PermissionLogEntry> {
    log::debug!("Getting permission history for session={}", session_id);
    permission_log::read_permission_log(&session_id)
}

#[tauri::command]
fn revive_session(session_id: String, workspace: String) -> Result<(), String> {
    // Validate session_id is a plausible UUID (alphanumeric + hyphens only)
    if !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid session ID".to_string());
    }
    // Validate workspace path
    security::sanitize_workspace_path(&workspace).map_err(|e| e.to_string())?;

    spawn_terminal_with_resume(&session_id, &workspace)
}

#[tauri::command]
fn save_preset(preset: models::SignalPreset) -> Result<(), String> {
    let dir = paths::presets_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create presets dir: {}", e))?;
    let path = dir.join(format!("{}.json", preset.id));
    let data = serde_json::to_vec(&preset)
        .map_err(|e| format!("Failed to serialize preset: {}", e))?;
    security::atomic_write(&path, &data)
        .map_err(|e| format!("Failed to save preset: {}", e))
}

#[tauri::command]
fn list_presets() -> Result<Vec<models::PresetSummary>, String> {
    let dir = paths::presets_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read presets dir: {}", e))?;
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
    summaries.sort_by(|a, b| b.created_at.partial_cmp(&a.created_at).unwrap_or(std::cmp::Ordering::Equal));
    Ok(summaries)
}

#[tauri::command]
fn load_preset(id: String) -> Result<models::SignalPreset, String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid preset ID".to_string());
    }
    let path = paths::presets_dir().join(format!("{}.json", id));
    let data = std::fs::read(&path)
        .map_err(|e| format!("Failed to read preset: {}", e))?;
    serde_json::from_slice(&data)
        .map_err(|e| format!("Failed to parse preset: {}", e))
}

#[tauri::command]
fn delete_preset(id: String) -> Result<(), String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid preset ID".to_string());
    }
    let path = paths::presets_dir().join(format!("{}.json", id));
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete preset: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn rename_preset(id: String, name: String) -> Result<(), String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid preset ID".to_string());
    }
    let path = paths::presets_dir().join(format!("{}.json", id));
    let data = std::fs::read(&path)
        .map_err(|e| format!("Failed to read preset: {}", e))?;
    let mut preset: models::SignalPreset = serde_json::from_slice(&data)
        .map_err(|e| format!("Failed to parse preset: {}", e))?;
    preset.name = name;
    let updated = serde_json::to_vec(&preset)
        .map_err(|e| format!("Failed to serialize preset: {}", e))?;
    security::atomic_write(&path, &updated)
        .map_err(|e| format!("Failed to save preset: {}", e))
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
    std::process::Command::new("cmd")
        .args([
            "/c", "start", "cmd", "/k",
            &format!("cd /d \"{}\" && claude --resume \"{}\"", workspace, session_id),
        ])
        .spawn()
        .map_err(|e| format!("Failed to open terminal: {}", e))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn spawn_terminal_with_resume(_session_id: &str, _workspace: &str) -> Result<(), String> {
    Err("Revive is not supported on this platform".to_string())
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
            let m = monitor_poll.clone();
            let sessions = tokio::task::spawn_blocking(move || {
                m.poll_status();
                m.enriched_sessions.lock().unwrap().clone()
            }).await.unwrap_or_default();
            let _ = app_poll.emit("sessions-updated", &sessions);
        }
    });

    // Refresh metrics every 5 seconds (session-level JSONL parsing)
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));
        loop {
            interval.tick().await;
            let m = monitor.clone();
            let _ = tokio::task::spawn_blocking(move || {
                m.refresh_metrics();
            }).await;
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
    let pending_permissions = Arc::new(permission_server::PendingRequests::new());
    let permission_metadata: Arc<Mutex<HashMap<String, models::PermissionRequest>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let pending_for_server = pending_permissions.clone();
    let metadata_for_server = permission_metadata.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState {
            monitor: monitor.clone(),
            pending_permissions,
            permission_metadata,
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
        ])
        .on_window_event(|window, event| {
            // Hide main window instead of quitting — app stays in tray.
            // Let secondary windows (signal-settings, etc.) close normally.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let monitor_tray = monitor.clone();

            // --- Apply system theme to window ---
            let system_theme = detect_system_theme();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_theme(Some(system_theme));
            }

            // --- Theme change polling (for "auto" mode) ---
            {
                let theme_handle = handle.clone();
                let mut last_theme = detect_system_theme();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(2));
                    loop {
                        interval.tick().await;
                        let current = detect_system_theme();
                        if current != last_theme {
                            last_theme = current;
                            let theme_str = match current {
                                Theme::Light => "light",
                                Theme::Dark => "dark",
                                _ => "dark",
                            };
                            let _ = theme_handle.emit("system-theme-changed", theme_str);
                            // Also update the webview window theme so CSS media queries work
                            if let Some(w) = theme_handle.get_webview_window("main") {
                                let _ = w.set_theme(Some(current));
                            }
                        }
                    }
                });
            }

            // --- System Tray ---
            setup_tray(&handle, &monitor_tray)?;

            // --- Blink timer (0.5s) ---
            spawn_blink_timer(handle.clone(), monitor_tray.clone());

            // --- Data polling timers ---
            spawn_timers(handle.clone(), monitor);

            // --- Permission server (localhost-only HTTP for Claude Code hooks) ---
            // Only start if user has opted in via settings
            let perm_settings = settings::load_settings();
            if perm_settings.permissions_enabled {
                spawn_permission_server(handle, pending_for_server, metadata_for_server);
                log::info!("Permission server started (permissions_enabled=true)");
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

            tokio::spawn(async move {
                if let Err(e) = handle_permission_connection(stream, app, pending, metadata).await {
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
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Read the HTTP request (headers + body in one read for small payloads)
    let mut buf = vec![0u8; 16384];
    let n = stream.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }
    let raw = &buf[..n];

    // Find end of headers
    let header_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .unwrap_or(n);
    let header_str = String::from_utf8_lossy(&raw[..header_end]);

    let first_line = header_str.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    let method = parts.first().copied().unwrap_or("");
    let path = parts.get(1).copied().unwrap_or("");

    match (method, path) {
        ("GET", "/health") => {
            let response = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK";
            stream.write_all(response.as_bytes()).await?;
        }
        ("POST", "/permission-request") => {
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

            // Store metadata for logging on decision
            metadata
                .lock()
                .unwrap()
                .insert(request_id.clone(), permission_req);

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

            // Wait for user decision (blocks this connection until approve/deny)
            let rx = pending.insert(&request_id);

            let decision = match rx.await {
                Ok(d) => d,
                Err(_) => {
                    // Channel dropped (timeout or cleanup)
                    metadata.lock().unwrap().remove(&request_id);
                    let response = "HTTP/1.1 504 Gateway Timeout\r\nContent-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\n\r\nTimeout";
                    stream.write_all(response.as_bytes()).await?;
                    return Ok(());
                }
            };

            let response_body = match decision {
                models::PermissionDecision::Allow => permission_server::format_allow_response(),
                models::PermissionDecision::Deny => permission_server::format_deny_response(),
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

/// Filter sessions to only those that are actively running or need attention.
/// Excludes "done" and "ended" sessions — these are shown as revivable in the
/// frontend and should not appear as tray dots or menu items.
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
    let all_sessions = monitor.enriched_sessions.lock().unwrap().clone();
    let sessions = tray_active_sessions(&all_sessions);
    let png_bytes = tray::render_dot_grid(&sessions, true, 44);
    let icon = tauri::image::Image::from_bytes(&png_bytes)?;

    let menu = build_tray_menu(handle, &sessions)?;

    TrayIconBuilder::with_id("claude-cue-tray")
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
    let last_menu_key: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let last_icon_key: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(500));
        loop {
            interval.tick().await;

            let all_sessions = monitor.enriched_sessions.lock().unwrap().clone();
            let sessions = tray_active_sessions(&all_sessions);
            let has_blinking = sessions
                .iter()
                .any(|s| s.info.state == "working" || s.info.state == "subagent");

            if !has_blinking {
                // No blinking needed — only update if sessions changed
                update_tray(&handle, &sessions, true, &last_menu_key, &last_icon_key);
                continue;
            }

            // Toggle blink phase
            let current = {
                let mut b = blink_on.lock().unwrap();
                *b = !*b;
                *b
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

/// Update the tray icon, tooltip, and menu with current session data.
/// The icon is only re-rendered when sessions or blink phase actually changes.
/// The menu is only rebuilt when session data changes (not on blink ticks)
/// to avoid dismissing an open menu on macOS.
fn update_tray(
    handle: &AppHandle,
    sessions: &[EnrichedSession],
    blink_on: bool,
    last_menu_key: &Arc<Mutex<String>>,
    last_icon_key: &Arc<Mutex<String>>,
) {
    let menu_key = menu_cache_key(sessions);
    let icon_key = format!("{}:{}", menu_key, blink_on as u8);

    let icon_changed = {
        let last = last_icon_key.lock().unwrap();
        *last != icon_key
    };

    if let Some(tray) = handle.tray_by_id("claude-cue-tray") {
        // Only render + push a new PNG when the visual state actually changed
        if icon_changed {
            let png_bytes = tray::render_dot_grid(sessions, blink_on, 44);
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
