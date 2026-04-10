//! Line-by-line JSONL parsing for Claude Code conversation logs.
//!
//! Handles three timestamp formats: Unix f64, ISO 8601 string, isoTimestamp field.
//! Extracts: type, timestamp, usage tokens, tool uses, model, custom title, git branch.

use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// Maximum file size we'll parse (500 MB).
const MAX_FILE_SIZE: u64 = 500 * 1024 * 1024;

/// A parsed entry from a JSONL line.
#[derive(Debug, Clone, Default)]
pub struct ParsedEntry {
    pub entry_type: String,
    pub timestamp: Option<f64>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub model: String,
    pub is_user_message: bool,
    pub is_assistant_message: bool,
    pub tool_counts: HashMap<String, i64>,
    pub custom_title: Option<String>,
    pub git_branch: Option<String>,
    pub agent_id: Option<String>,
    pub slug: Option<String>,
    /// True if this assistant message has stop_reason "tool_use"
    pub has_pending_tool_use: bool,
    /// True if this entry is a tool_result
    pub is_tool_result: bool,
    /// Name of the last tool_use in this message (for running tool display)
    pub running_tool_name: Option<String>,
    /// Target of the running tool (file path, command, pattern)
    pub running_tool_target: Option<String>,
    /// Todo items parsed from TodoWrite/TaskCreate tool uses in this message
    pub todo_items: Vec<crate::models::TodoItem>,
    /// True if todo_items is a bulk replacement (TodoWrite), false for incremental (TaskCreate)
    pub todo_is_bulk_replace: bool,
    /// Pending task status updates: (taskId, new_status) from TaskUpdate tool uses.
    /// Applied during aggregation against the accumulated todo list.
    pub task_status_updates: Vec<(String, String)>,
    /// Extracted text from user messages (first text content block, truncated)
    pub user_prompt_text: Option<String>,
    /// Session ID from JSONL metadata (permission-mode header entry)
    pub jsonl_session_id: Option<String>,
}

/// Parse a JSONL file into a list of entries.
/// Returns an empty Vec if the file is too large, unreadable, or empty.
pub fn parse_jsonl_file(path: &Path) -> Vec<ParsedEntry> {
    // Check file size
    if let Ok(metadata) = std::fs::metadata(path) {
        if metadata.len() > MAX_FILE_SIZE {
            log::warn!("Skipping oversized JSONL file: {:?} ({} bytes)", path, metadata.len());
            return Vec::new();
        }
    }

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            log::debug!("Failed to read JSONL file {:?}: {}", path, e);
            return Vec::new();
        }
    };

    parse_jsonl_content(&content)
}

/// Parse JSONL content string into entries.
pub fn parse_jsonl_content(content: &str) -> Vec<ParsedEntry> {
    content
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(parse_line)
        .collect()
}

/// Parse a single JSONL line.
fn parse_line(line: &str) -> Option<ParsedEntry> {
    let json: Value = serde_json::from_str(line).ok()?;
    let obj = json.as_object()?;

    let entry_type = obj.get("type")?.as_str()?.to_string();
    let mut entry = ParsedEntry {
        entry_type: entry_type.clone(),
        ..Default::default()
    };

    // Extract timestamp — try multiple formats
    entry.timestamp = extract_timestamp(obj);

    // Extract custom title
    if entry_type == "custom-title" {
        entry.custom_title = obj.get("customTitle").and_then(|v| v.as_str()).map(String::from);
    }

    // Extract session ID from metadata entries (permission-mode or system headers)
    if let Some(sid) = obj.get("sessionId").and_then(|v| v.as_str()) {
        entry.jsonl_session_id = Some(sid.to_string());
    }

    // Track git branch from any message that has it
    if let Some(branch) = obj.get("gitBranch").and_then(|v| v.as_str()) {
        if branch != "HEAD" {
            entry.git_branch = Some(branch.to_string());
        }
    }

    // Extract agent identifiers (for subagent JSONL files)
    entry.agent_id = obj.get("agentId").and_then(|v| v.as_str()).map(String::from);
    entry.slug = obj.get("slug").and_then(|v| v.as_str()).map(String::from);

    // Count user messages and extract prompt text
    if entry_type == "user" {
        entry.is_user_message = true;
        entry.user_prompt_text = extract_user_prompt_text(obj);
    }

    // Parse assistant messages for tokens and tool usage
    if entry_type == "assistant" {
        entry.is_assistant_message = true;

        if let Some(message) = obj.get("message").and_then(|v| v.as_object()) {
            // Model
            if let Some(model) = message.get("model").and_then(|v| v.as_str()) {
                entry.model = model.to_string();
            }

            // Usage
            if let Some(usage) = message.get("usage").and_then(|v| v.as_object()) {
                entry.input_tokens = usage
                    .get("input_tokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                entry.output_tokens = usage
                    .get("output_tokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                entry.cache_creation_tokens = usage
                    .get("cache_creation_input_tokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                entry.cache_read_tokens = usage
                    .get("cache_read_input_tokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
            }

            // Tool uses from message content
            if let Some(content) = message.get("content").and_then(|v| v.as_array()) {
                for block in content {
                    if let Some(block_obj) = block.as_object() {
                        if block_obj.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                            if let Some(name) = block_obj.get("name").and_then(|v| v.as_str()) {
                                *entry.tool_counts.entry(name.to_string()).or_insert(0) += 1;

                                // Track the last tool_use as the running tool
                                entry.running_tool_name = Some(name.to_string());
                                entry.running_tool_target =
                                    extract_tool_target(name, block_obj.get("input"));

                                // Parse TodoWrite/TaskCreate for todo tracking
                                if name == "TodoWrite" {
                                    parse_todo_write(block_obj.get("input"), &mut entry.todo_items);
                                    entry.todo_is_bulk_replace = true;
                                } else if name == "TaskCreate" || name == "TaskUpdate" {
                                    parse_task_tool(name, block_obj.get("input"), &mut entry);
                                }
                            }
                        }
                    }
                }
            }

            // Detect pending tool use (session is waiting for permission/input)
            if message.get("stop_reason").and_then(|v| v.as_str()) == Some("tool_use") {
                entry.has_pending_tool_use = true;
            }
        }
    }

    // Detect tool_result entries
    if entry_type == "tool_result" {
        entry.is_tool_result = true;
    }

    Some(entry)
}

/// Extract the target of a tool_use for display (file path, command, pattern).
fn extract_tool_target(tool_name: &str, input: Option<&Value>) -> Option<String> {
    let obj = input?.as_object()?;
    match tool_name {
        "Read" | "Write" | "Edit" | "NotebookEdit" => obj
            .get("file_path")
            .or_else(|| obj.get("path"))
            .and_then(|v| v.as_str())
            .map(shorten_path),
        "Bash" => obj
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| truncate(s, 60)),
        "Grep" | "Glob" => obj
            .get("pattern")
            .and_then(|v| v.as_str())
            .map(|s| truncate(s, 40)),
        "Agent" => obj
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| truncate(s, 40)),
        _ => None,
    }
}

/// Shorten a file path to just filename (or last 2 components if deeply nested).
fn shorten_path(path: &str) -> String {
    let p = std::path::Path::new(path);
    let components: Vec<_> = p.components().rev().take(2).collect();
    if components.len() == 2 {
        format!(
            "{}/{}",
            components[1].as_os_str().to_string_lossy(),
            components[0].as_os_str().to_string_lossy()
        )
    } else {
        p.file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string())
    }
}

use crate::summary_formatter::truncate;

/// Parse TodoWrite input to extract todo items (bulk replace format).
fn parse_todo_write(input: Option<&Value>, items: &mut Vec<crate::models::TodoItem>) {
    if let Some(obj) = input.and_then(|v| v.as_object()) {
        if let Some(todos) = obj.get("todos").and_then(|v| v.as_array()) {
            // TodoWrite replaces all items — clear previous
            items.clear();
            for todo in todos {
                if let Some(todo_obj) = todo.as_object() {
                    items.push(crate::models::TodoItem {
                        content: todo_obj
                            .get("content")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        status: todo_obj
                            .get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("pending")
                            .to_string(),
                    });
                }
            }
        }
    }
}

/// Parse TaskCreate/TaskUpdate input to incrementally update todo items.
fn parse_task_tool(tool_name: &str, input: Option<&Value>, entry: &mut ParsedEntry) {
    if let Some(obj) = input.and_then(|v| v.as_object()) {
        if tool_name == "TaskCreate" {
            let content = obj
                .get("subject")
                .or_else(|| obj.get("description"))
                .and_then(|v| v.as_str())
                .unwrap_or("Task")
                .to_string();
            entry.todo_items.push(crate::models::TodoItem {
                content,
                status: "pending".to_string(),
            });
        } else if tool_name == "TaskUpdate" {
            // Store the update for application during aggregation, when we
            // have the full accumulated task list to index into.
            if let Some(new_status) = obj.get("status").and_then(|v| v.as_str()) {
                let normalized = match new_status {
                    "in_progress" | "running" => "in_progress",
                    "completed" | "complete" | "done" => "completed",
                    other => other,
                };
                if let Some(task_id) = obj.get("taskId").and_then(|v| v.as_str()) {
                    entry.task_status_updates.push((task_id.to_string(), normalized.to_string()));
                }
            }
        }
    }
}

/// Extract a Unix timestamp from a JSONL entry, trying multiple formats.
fn extract_timestamp(obj: &serde_json::Map<String, Value>) -> Option<f64> {
    // Format 1: Unix float in "timestamp" field
    if let Some(ts) = obj.get("timestamp") {
        if let Some(f) = ts.as_f64() {
            return Some(f);
        }
        // Format 2: ISO 8601 string in "timestamp" field
        if let Some(s) = ts.as_str() {
            if let Some(t) = parse_iso8601(s) {
                return Some(t);
            }
        }
    }
    // Format 3: ISO 8601 string in "isoTimestamp" field
    if let Some(ts) = obj.get("isoTimestamp").and_then(|v| v.as_str()) {
        if let Some(t) = parse_iso8601(ts) {
            return Some(t);
        }
    }
    None
}

/// Parse an ISO 8601 datetime string to Unix timestamp.
fn parse_iso8601(s: &str) -> Option<f64> {
    // Try with fractional seconds first
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp() as f64 + dt.timestamp_subsec_nanos() as f64 / 1_000_000_000.0);
    }
    // Try without fractional seconds
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return Some(dt.and_utc().timestamp() as f64);
    }
    // Try with Z suffix but no fractional
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%SZ") {
        return Some(dt.and_utc().timestamp() as f64);
    }
    None
}

/// Extract the first text content from a user message (full text, not truncated).
/// Handles both string content and array-of-blocks content formats.
/// Strips XML tags (like <command-message>) to get plain user text.
fn extract_user_prompt_text(obj: &serde_json::Map<String, Value>) -> Option<String> {
    let message = obj.get("message")?.as_object()?;
    let content = message.get("content")?;

    let raw = if let Some(s) = content.as_str() {
        // Skip JSON objects injected as user-role messages by the Claude Code harness
        // (e.g. idle_notification, teammate_terminated, shutdown_approved events).
        let trimmed_s = s.trim();
        if trimmed_s.starts_with('{') && trimmed_s.ends_with('}') {
            if let Ok(v) = serde_json::from_str::<Value>(trimmed_s) {
                if v.get("type").is_some() {
                    return None;
                }
            }
        }
        s.to_string()
    } else if let Some(arr) = content.as_array() {
        // Find the first text block
        arr.iter()
            .find_map(|block| {
                let obj = block.as_object()?;
                if obj.get("type")?.as_str()? == "text" {
                    obj.get("text")?.as_str().map(String::from)
                } else {
                    None
                }
            })?
    } else {
        return None;
    };

    // Strip XML-like tags and trim
    let stripped = strip_xml_tags(&raw);
    // Also strip bracket-style markers like [Image source: ...] and [Image #N]
    let stripped = strip_bracket_markers(&stripped);
    let trimmed = stripped.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_string())
}

/// Strip XML/HTML-like tags from a string.
fn strip_xml_tags(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        if ch == '<' {
            in_tag = true;
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(ch);
        }
    }
    result
}

/// Strip bracket-style markers injected by the Claude Code harness.
/// Removes patterns like [Image source: /path/to/img.png], [Image #3],
/// [image source: ...], etc., leaving only real user text.
fn strip_bracket_markers(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '[' {
            // Collect until matching ']' or end of string
            let mut marker = String::new();
            let mut closed = false;
            for inner in chars.by_ref() {
                if inner == ']' {
                    closed = true;
                    break;
                }
                marker.push(inner);
            }
            if closed {
                let lower = marker.to_lowercase();
                // Drop image/attachment markers
                if lower.starts_with("image") || lower.starts_with("attachment") {
                    // skip — don't push to result
                    continue;
                }
            }
            // Not a known marker — put it back verbatim
            result.push('[');
            result.push_str(&marker);
            if closed {
                result.push(']');
            }
        } else {
            result.push(ch);
        }
    }
    result
}

/// What the last meaningful JSONL entry tells us about session state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LastEntryVerdict {
    /// Last entry is a user message — Claude is still thinking/generating.
    StillWorking,
    /// Last entry is a completed assistant turn (end_turn) — turn finished.
    TurnFinished,
    /// Last entry is assistant with pending tool_use — waiting for tool result.
    PendingToolUse,
    /// Could not determine (empty file, read error, etc.)
    Unknown,
}

/// Efficiently read the tail of a JSONL file and determine session state.
///
/// Reads the last ~16KB of the file and finds the last `user`, `assistant`,
/// or `tool_result` entry to infer whether the session is still active.
pub fn check_last_entry_verdict(path: &Path) -> LastEntryVerdict {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return LastEntryVerdict::Unknown,
    };

    use std::io::{Read, Seek, SeekFrom};
    let mut file = file;
    let size = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return LastEntryVerdict::Unknown,
    };

    // Read last 16KB
    let chunk_size: u64 = 16 * 1024;
    let offset = if size > chunk_size { size - chunk_size } else { 0 };
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return LastEntryVerdict::Unknown;
    }

    let mut buf = Vec::with_capacity(chunk_size as usize);
    if file.read_to_end(&mut buf).is_err() {
        return LastEntryVerdict::Unknown;
    }

    let tail = String::from_utf8_lossy(&buf);

    // Scan lines in reverse to find the last meaningful entry
    for line in tail.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let json: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let entry_type = match json.get("type").and_then(|v| v.as_str()) {
            Some(t) => t,
            None => continue,
        };

        match entry_type {
            "user" => return LastEntryVerdict::StillWorking,
            "tool_result" => return LastEntryVerdict::StillWorking,
            "assistant" => {
                // Check stop_reason
                let stop_reason = json
                    .get("message")
                    .and_then(|m| m.get("stop_reason"))
                    .and_then(|v| v.as_str());
                return match stop_reason {
                    Some("tool_use") => LastEntryVerdict::PendingToolUse,
                    _ => LastEntryVerdict::TurnFinished,
                };
            }
            // Skip other entry types (custom-title, progress, etc.)
            _ => continue,
        }
    }

    LastEntryVerdict::Unknown
}

/// Parse a subagent JSONL file and its companion .meta.json into SubagentMetrics.
pub fn parse_subagent_jsonl(jsonl_path: &Path) -> Option<crate::models::SubagentMetrics> {
    let entries = parse_jsonl_file(jsonl_path);
    if entries.is_empty() {
        return None;
    }

    let mut m = crate::models::SubagentMetrics::default();

    // Check if the file was modified recently (within 60s = active)
    m.is_active = std::fs::metadata(jsonl_path)
        .and_then(|meta| meta.modified())
        .map(|mod_time| {
            mod_time.elapsed().map(|elapsed| elapsed.as_secs() < 60).unwrap_or(false)
        })
        .unwrap_or(false);

    // Extract agentId and slug from first entry that has them
    for entry in &entries {
        if m.agent_id.is_empty() {
            if let Some(ref id) = entry.agent_id {
                m.agent_id = id.clone();
            }
        }
        if m.slug.is_empty() {
            if let Some(ref slug) = entry.slug {
                m.slug = slug.clone();
            }
        }
        if !m.agent_id.is_empty() && !m.slug.is_empty() {
            break;
        }
    }

    // Aggregate metrics
    for entry in &entries {
        if entry.is_assistant_message {
            m.message_count += 1;
            if !entry.model.is_empty() {
                m.model = entry.model.clone();
            }
            m.input_tokens += entry.input_tokens;
            m.output_tokens += entry.output_tokens;
            m.cache_creation_tokens += entry.cache_creation_tokens;
            m.cache_read_tokens += entry.cache_read_tokens;
            for (tool, count) in &entry.tool_counts {
                *m.tool_counts.entry(tool.clone()).or_insert(0) += count;
            }
        }
    }

    // Read companion .meta.json for description
    if let Some(stem) = jsonl_path.file_stem().and_then(|s| s.to_str()) {
        let meta_filename = format!("{}.meta.json", stem);
        if let Some(parent) = jsonl_path.parent() {
            let meta_path = parent.join(meta_filename);
            if let Ok(content) = std::fs::read_to_string(&meta_path) {
                if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(desc) = meta.get("description").and_then(|v| v.as_str()) {
                        m.description = desc.to_string();
                    }
                }
            }
        }
    }

    Some(m)
}

/// Parse a JSONL file and extract aggregated SessionMetrics (for session_monitor).
pub fn parse_jsonl_to_session_metrics(path: &Path) -> Option<crate::models::SessionMetrics> {
    let entries = parse_jsonl_file(path);
    if entries.is_empty() {
        return None;
    }

    let mut m = crate::models::SessionMetrics::default();

    for entry in &entries {
        // Session ID from JSONL metadata — first occurrence wins
        if m.last_prompt_session_id.is_none() {
            if let Some(ref sid) = entry.jsonl_session_id {
                m.last_prompt_session_id = Some(sid.clone());
            }
        }

        // Custom title — last one wins
        if let Some(ref title) = entry.custom_title {
            m.custom_title = Some(title.clone());
        }

        // Git branch — last non-HEAD wins
        if let Some(ref branch) = entry.git_branch {
            m.git_branch = Some(branch.clone());
        }

        if entry.is_user_message {
            m.user_message_count += 1;
            // Last user prompt text wins
            if let Some(ref text) = entry.user_prompt_text {
                m.last_prompt = Some(text.clone());
            }
        }

        if entry.is_assistant_message {
            m.message_count += 1;

            if !entry.model.is_empty() {
                m.model = entry.model.clone();
            }

            m.input_tokens += entry.input_tokens;
            m.output_tokens += entry.output_tokens;
            m.cache_creation_tokens += entry.cache_creation_tokens;
            m.cache_read_tokens += entry.cache_read_tokens;

            // Context usage = input tokens + output tokens for the last message
            // (output tokens become part of conversation history for the next turn)
            m.last_input_tokens =
                entry.input_tokens + entry.cache_creation_tokens + entry.cache_read_tokens
                + entry.output_tokens;

            for (tool, count) in &entry.tool_counts {
                *m.tool_counts.entry(tool.clone()).or_insert(0) += count;
            }
        }
    }

    // Detect pending tool_use: scan backwards from end to find if the last
    // assistant message with tool_use has no subsequent tool_result.
    // This indicates the session is waiting for permission/user input.
    for entry in entries.iter().rev() {
        if entry.is_tool_result {
            // A tool_result was found before any pending assistant — not waiting
            break;
        }
        if entry.has_pending_tool_use {
            m.pending_tool_use = true;
            m.running_tool_name = entry.running_tool_name.clone();
            m.running_tool_target = entry.running_tool_target.clone();
            break;
        }
        // Skip non-relevant entries (e.g., progress, thinking)
    }

    // Todo items: accumulate from all entries.
    // TodoWrite (bulk_replace=true) replaces the entire list.
    // TaskCreate (bulk_replace=false) appends incrementally.
    // TaskUpdate status changes are applied after accumulation.
    for entry in &entries {
        if !entry.todo_items.is_empty() {
            if entry.todo_is_bulk_replace {
                m.todo_items = entry.todo_items.clone();
            } else {
                for item in &entry.todo_items {
                    m.todo_items.push(item.clone());
                }
            }
        }
        // Apply TaskUpdate status changes against the accumulated list
        for (task_id, new_status) in &entry.task_status_updates {
            if let Ok(idx) = task_id.parse::<usize>() {
                if idx > 0 && idx <= m.todo_items.len() {
                    m.todo_items[idx - 1].status = new_status.clone();
                }
            }
        }
    }

    // Discover subagents: {session_stem}/subagents/*.jsonl
    if let Some(parent_dir) = path.parent() {
        if let Some(session_stem) = path.file_stem().and_then(|s| s.to_str()) {
            let subagents_dir = parent_dir.join(session_stem).join("subagents");
            if subagents_dir.is_dir() {
                if let Ok(dir_entries) = std::fs::read_dir(&subagents_dir) {
                    for dir_entry in dir_entries.flatten() {
                        let file_path = dir_entry.path();
                        if file_path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                            if let Some(sub_metrics) = parse_subagent_jsonl(&file_path) {
                                m.subagents.push(sub_metrics);
                            }
                        }
                    }
                }
                // Sort by description for stable display order
                m.subagents.sort_by(|a, b| a.description.cmp(&b.description));
            }
        }
    }

    Some(m)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const ASSISTANT_WITH_USAGE: &str = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":1000,"output_tokens":500,"cache_creation_input_tokens":200,"cache_read_input_tokens":800},"content":[{"type":"tool_use","name":"Bash"},{"type":"tool_use","name":"Read"},{"type":"tool_use","name":"Bash"}]}}"#;

    const USER_MESSAGE: &str = r#"{"type":"user","timestamp":1710000001.0}"#;

    const CUSTOM_TITLE: &str = r#"{"type":"custom-title","timestamp":1710000002.0,"customTitle":"Auth Refactor"}"#;

    const ISO_TIMESTAMP: &str = r#"{"type":"assistant","isoTimestamp":"2024-03-10T12:00:00Z","message":{"model":"claude-opus-4-6","usage":{"input_tokens":2000,"output_tokens":1000},"content":[]}}"#;

    const GIT_BRANCH: &str = r#"{"type":"user","timestamp":1710000003.0,"gitBranch":"feat/dashboard"}"#;

    const MALFORMED: &str = r#"{"type":invalid json here"#;

    #[test]
    fn test_parse_assistant_with_usage() {
        let entries = parse_jsonl_content(ASSISTANT_WITH_USAGE);
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.entry_type, "assistant");
        assert!(e.is_assistant_message);
        assert!(!e.is_user_message);
        assert_eq!(e.input_tokens, 1000);
        assert_eq!(e.output_tokens, 500);
        assert_eq!(e.cache_creation_tokens, 200);
        assert_eq!(e.cache_read_tokens, 800);
        assert_eq!(e.model, "claude-sonnet-4-6");
        assert_eq!(e.tool_counts.get("Bash"), Some(&2));
        assert_eq!(e.tool_counts.get("Read"), Some(&1));
        assert!((e.timestamp.unwrap() - 1710000000.0).abs() < 0.001);
    }

    #[test]
    fn test_parse_user_message() {
        let entries = parse_jsonl_content(USER_MESSAGE);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_user_message);
        assert!(!entries[0].is_assistant_message);
    }

    #[test]
    fn test_parse_custom_title() {
        let entries = parse_jsonl_content(CUSTOM_TITLE);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].custom_title.as_deref(),
            Some("Auth Refactor")
        );
    }

    #[test]
    fn test_parse_iso_timestamp() {
        let entries = parse_jsonl_content(ISO_TIMESTAMP);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].timestamp.is_some());
        assert_eq!(entries[0].model, "claude-opus-4-6");
        assert_eq!(entries[0].input_tokens, 2000);
    }

    #[test]
    fn test_parse_git_branch() {
        let entries = parse_jsonl_content(GIT_BRANCH);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].git_branch.as_deref(),
            Some("feat/dashboard")
        );
    }

    #[test]
    fn test_malformed_line_skipped() {
        let content = format!("{}\n{}\n{}", ASSISTANT_WITH_USAGE, MALFORMED, USER_MESSAGE);
        let entries = parse_jsonl_content(&content);
        assert_eq!(entries.len(), 2); // malformed line skipped
    }

    #[test]
    fn test_empty_content() {
        let entries = parse_jsonl_content("");
        assert!(entries.is_empty());
    }

    #[test]
    fn test_session_metrics_aggregation() {
        let content = format!(
            "{}\n{}\n{}\n{}\n{}",
            USER_MESSAGE, ASSISTANT_WITH_USAGE, CUSTOM_TITLE, GIT_BRANCH, ISO_TIMESTAMP
        );

        let dir = std::env::temp_dir().join("cue_test_jsonl");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jsonl");
        std::fs::write(&path, &content).unwrap();

        let metrics = parse_jsonl_to_session_metrics(&path).unwrap();
        assert_eq!(metrics.user_message_count, 2); // user + gitBranch user
        assert_eq!(metrics.message_count, 2); // two assistant messages
        assert_eq!(metrics.input_tokens, 3000); // 1000 + 2000
        assert_eq!(metrics.output_tokens, 1500); // 500 + 1000
        assert_eq!(metrics.custom_title.as_deref(), Some("Auth Refactor"));
        assert_eq!(metrics.git_branch.as_deref(), Some("feat/dashboard"));
        assert_eq!(metrics.model, "claude-opus-4-6"); // last model wins

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_three_timestamp_formats() {
        // Unix float
        let e1 = parse_jsonl_content(r#"{"type":"user","timestamp":1710000000.5}"#);
        assert!((e1[0].timestamp.unwrap() - 1710000000.5).abs() < 0.001);

        // ISO string in timestamp field
        let e2 = parse_jsonl_content(
            r#"{"type":"user","timestamp":"2024-03-10T12:00:00+00:00"}"#,
        );
        assert!(e2[0].timestamp.is_some());

        // isoTimestamp field
        let e3 = parse_jsonl_content(
            r#"{"type":"user","isoTimestamp":"2024-03-10T12:00:00Z"}"#,
        );
        assert!(e3[0].timestamp.is_some());
    }

    #[test]
    fn test_running_tool_extraction() {
        let line = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/Users/dev/src/main.rs"}}],"stop_reason":"tool_use"}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].has_pending_tool_use);
        assert_eq!(entries[0].running_tool_name.as_deref(), Some("Read"));
        assert_eq!(entries[0].running_tool_target.as_deref(), Some("src/main.rs"));
    }

    #[test]
    fn test_running_tool_bash_target() {
        let line = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm run build"}}],"stop_reason":"tool_use"}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries[0].running_tool_name.as_deref(), Some("Bash"));
        assert_eq!(entries[0].running_tool_target.as_deref(), Some("npm run build"));
    }

    #[test]
    fn test_todo_write_parsing() {
        let line = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"TodoWrite","input":{"todos":[{"content":"Fix bug","status":"in_progress"},{"content":"Write tests","status":"pending"},{"content":"Deploy","status":"completed"}]}}]}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries[0].todo_items.len(), 3);
        assert!(entries[0].todo_is_bulk_replace);
        assert_eq!(entries[0].todo_items[0].content, "Fix bug");
        assert_eq!(entries[0].todo_items[0].status, "in_progress");
        assert_eq!(entries[0].todo_items[2].status, "completed");
    }

    #[test]
    fn test_task_create_parsing() {
        let line = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"TaskCreate","input":{"subject":"Implement auth","description":"Add OAuth2 login"}}]}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries[0].todo_items.len(), 1);
        assert!(!entries[0].todo_is_bulk_replace);
        assert_eq!(entries[0].todo_items[0].content, "Implement auth");
        assert_eq!(entries[0].todo_items[0].status, "pending");
    }

    #[test]
    fn test_task_update_stores_status_change() {
        let line = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"TaskUpdate","input":{"taskId":"1","status":"completed"}}]}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries[0].task_status_updates.len(), 1);
        assert_eq!(entries[0].task_status_updates[0].0, "1");
        assert_eq!(entries[0].task_status_updates[0].1, "completed");
    }

    #[test]
    fn test_todo_aggregation_with_task_update() {
        // TaskCreate, then TaskUpdate to mark it completed
        let create_line = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"TaskCreate","input":{"subject":"Build feature"}}]}}"#;
        let update_line = r#"{"type":"assistant","timestamp":1710000001.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"TaskUpdate","input":{"taskId":"1","status":"completed"}}]}}"#;

        let dir = std::env::temp_dir().join("cue_test_todo_agg");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jsonl");
        std::fs::write(&path, format!("{}\n{}", create_line, update_line)).unwrap();

        let metrics = parse_jsonl_to_session_metrics(&path).unwrap();
        assert_eq!(metrics.todo_items.len(), 1);
        assert_eq!(metrics.todo_items[0].content, "Build feature");
        assert_eq!(metrics.todo_items[0].status, "completed");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_extract_tool_target_grep() {
        let input = serde_json::json!({"pattern": "fn main"});
        let target = extract_tool_target("Grep", Some(&input));
        assert_eq!(target.as_deref(), Some("fn main"));
    }

    #[test]
    fn test_shorten_path_deep() {
        let short = shorten_path("/Users/dev/src/components/Dashboard.tsx");
        assert_eq!(short, "components/Dashboard.tsx");
    }

    #[test]
    fn test_shorten_path_simple() {
        let short = shorten_path("main.rs");
        assert_eq!(short, "main.rs");
    }

    #[test]
    fn test_pending_tool_use_with_running_tool() {
        let assistant = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/src/lib.rs"}}],"stop_reason":"tool_use"}}"#;

        let dir = std::env::temp_dir().join("cue_test_pending_tool");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jsonl");
        std::fs::write(&path, assistant).unwrap();

        let metrics = parse_jsonl_to_session_metrics(&path).unwrap();
        assert!(metrics.pending_tool_use);
        assert_eq!(metrics.running_tool_name.as_deref(), Some("Edit"));
        assert!(metrics.running_tool_target.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // -- check_last_entry_verdict tests --

    fn write_temp_jsonl(name: &str, content: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("cue_test_verdict_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jsonl");
        std::fs::write(&path, content).unwrap();
        (dir, path)
    }

    #[test]
    fn test_verdict_user_last_is_still_working() {
        let content = format!(
            "{}\n{}",
            r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[],"stop_reason":"end_turn"}}"#,
            r#"{"type":"user","timestamp":1710000010.0}"#,
        );
        let (dir, path) = write_temp_jsonl("user_last", &content);
        assert_eq!(check_last_entry_verdict(&path), LastEntryVerdict::StillWorking);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_verdict_assistant_end_turn_is_finished() {
        let content = format!(
            "{}\n{}",
            r#"{"type":"user","timestamp":1710000000.0}"#,
            r#"{"type":"assistant","timestamp":1710000005.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[],"stop_reason":"end_turn"}}"#,
        );
        let (dir, path) = write_temp_jsonl("end_turn", &content);
        assert_eq!(check_last_entry_verdict(&path), LastEntryVerdict::TurnFinished);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_verdict_assistant_tool_use_is_pending() {
        let content = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"Bash","input":{"command":"sleep 60"}}],"stop_reason":"tool_use"}}"#;
        let (dir, path) = write_temp_jsonl("tool_use", content);
        assert_eq!(check_last_entry_verdict(&path), LastEntryVerdict::PendingToolUse);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_verdict_tool_result_last_is_still_working() {
        let content = format!(
            "{}\n{}",
            r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"Read","input":{}}],"stop_reason":"tool_use"}}"#,
            r#"{"type":"tool_result","timestamp":1710000005.0}"#,
        );
        let (dir, path) = write_temp_jsonl("tool_result", &content);
        assert_eq!(check_last_entry_verdict(&path), LastEntryVerdict::StillWorking);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_verdict_empty_file_is_unknown() {
        let (dir, path) = write_temp_jsonl("empty", "");
        assert_eq!(check_last_entry_verdict(&path), LastEntryVerdict::Unknown);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_verdict_nonexistent_file_is_unknown() {
        let path = std::env::temp_dir().join("cue_test_verdict_nonexistent/nope.jsonl");
        assert_eq!(check_last_entry_verdict(&path), LastEntryVerdict::Unknown);
    }

    #[test]
    fn test_verdict_skips_non_message_entries() {
        // custom-title after user should still return StillWorking
        let content = format!(
            "{}\n{}",
            r#"{"type":"user","timestamp":1710000000.0}"#,
            r#"{"type":"custom-title","timestamp":1710000001.0,"customTitle":"My Task"}"#,
        );
        let (dir, path) = write_temp_jsonl("skip_custom", &content);
        assert_eq!(check_last_entry_verdict(&path), LastEntryVerdict::StillWorking);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
