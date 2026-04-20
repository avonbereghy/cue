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
    /// If this user message is a `/effort X` slash-command, the raw argument
    /// (e.g. "high", "auto", "max"). Pass-through string so new level names
    /// Anthropic introduces surface automatically.
    pub effort_command: Option<String>,
    /// Timestamp (unix secs) of the effort command, if any — used to compare
    /// against the global settings.json mtime so the fresher source wins.
    pub effort_command_ts: Option<f64>,
    /// Session ID from JSONL metadata (permission-mode header entry)
    pub jsonl_session_id: Option<String>,
    /// Team name from JSONL (team agent sessions)
    pub team_name: Option<String>,
    /// Agent name from JSONL (team agent sessions)
    pub agent_name: Option<String>,
    /// True if this assistant message has at least one non-empty `text`
    /// content block — i.e., user-visible response prose has begun. Distinct
    /// from `thinking` blocks (extended thinking) which also count as
    /// output tokens but should not promote the card from thinking→working.
    pub has_text_content: bool,
    /// First non-empty `text` content block from this assistant message, used
    /// as a disambiguation hint on idle/done cards when two sessions share a
    /// workspace. Captured regardless of block position so the snippet is
    /// deterministic.
    pub assistant_text: Option<String>,
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

    // Extract team agent metadata (present on every entry for team-spawned sessions)
    entry.team_name = obj.get("teamName").and_then(|v| v.as_str()).map(String::from);
    entry.agent_name = obj.get("agentName").and_then(|v| v.as_str()).map(String::from);

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
        entry.effort_command = extract_effort_command(obj);
        if entry.effort_command.is_some() {
            entry.effort_command_ts = entry.timestamp;
        }
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
                        let block_type = block_obj.get("type").and_then(|v| v.as_str());
                        if block_type == Some("text") {
                            if let Some(text) = block_obj.get("text").and_then(|v| v.as_str()) {
                                let trimmed = text.trim();
                                if !trimmed.is_empty() {
                                    entry.has_text_content = true;
                                    if entry.assistant_text.is_none() {
                                        entry.assistant_text = Some(trimmed.to_string());
                                    }
                                }
                            }
                        }
                        if block_type == Some("tool_use") {
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
        // Skip ANSI-formatted messages injected by the harness (e.g. "\x1b[2mCompacted ...")
        // Real user input never contains ANSI escape sequences.
        if trimmed_s.starts_with('\x1b') {
            return None;
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

    // Strip ANSI escape sequences (e.g. \x1b[2m for dim text)
    let stripped = strip_ansi_escapes(&raw);
    // Strip XML-like tags and trim
    let stripped = strip_xml_tags(&stripped);
    // Also strip bracket-style markers like [Image source: ...] and [Image #N]
    let stripped = strip_bracket_markers(&stripped);
    let trimmed = stripped.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_string())
}

/// Extract the `/effort X` argument from a user message, if present.
///
/// Claude Code represents slash commands in the JSONL as raw XML tags inside
/// the user-role message content, e.g.:
///   `<command-name>/effort</command-name><command-args>high</command-args>`
/// We parse the raw content (before XML stripping) so the args survive.
fn extract_effort_command(obj: &serde_json::Map<String, Value>) -> Option<String> {
    let message = obj.get("message")?.as_object()?;
    let content = message.get("content")?;

    let raw = if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(arr) = content.as_array() {
        arr.iter().find_map(|block| {
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

    if !raw.contains("<command-name>/effort</command-name>") {
        return None;
    }
    let start_tag = "<command-args>";
    let end_tag = "</command-args>";
    let start = raw.find(start_tag)? + start_tag.len();
    let rest = &raw[start..];
    let end_rel = rest.find(end_tag)?;
    let args = rest[..end_rel].trim();
    if args.is_empty() {
        return None;
    }
    let lowered = args.to_lowercase();
    // Accept any 3+ char lowercase-alpha word so future levels (ultra, xhigh,
    // whatever Anthropic adds next) still pass. Reject typos/stray chars like
    // a single "x" or "3" — those would otherwise render as a literal pill
    // value and misrepresent what the model is actually running at.
    if lowered.len() < 3 || !lowered.chars().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    Some(lowered)
}

/// Strip ANSI escape sequences (CSI sequences like \x1b[...m and OSC sequences).
fn strip_ansi_escapes(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            // Consume the escape sequence
            if let Some(next) = chars.next() {
                if next == '[' {
                    // CSI sequence: consume until a letter (@ through ~)
                    for c in chars.by_ref() {
                        if c.is_ascii_alphabetic() || c == '~' || c == '@' {
                            break;
                        }
                    }
                } else if next == ']' {
                    // OSC sequence: consume until ST (\x1b\\) or BEL (\x07)
                    let mut prev = '\0';
                    for c in chars.by_ref() {
                        if c == '\x07' || (prev == '\x1b' && c == '\\') {
                            break;
                        }
                        prev = c;
                    }
                }
                // Other escape types (e.g. \x1b followed by single char): already consumed
            }
        } else {
            result.push(ch);
        }
    }
    result
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
        // Track earliest and latest entry timestamps for start/end display.
        if let Some(ts) = entry.timestamp {
            m.started_at = Some(m.started_at.map_or(ts, |s| s.min(ts)));
            m.ended_at = Some(m.ended_at.map_or(ts, |e| e.max(ts)));
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

        // Team agent metadata — first occurrence wins
        if m.team_name.is_none() {
            if let Some(ref tn) = entry.team_name {
                m.team_name = Some(tn.clone());
            }
        }
        if m.agent_name.is_none() {
            if let Some(ref an) = entry.agent_name {
                m.agent_name = Some(an.clone());
            }
        }

        if entry.is_user_message {
            m.user_message_count += 1;
            // Last user prompt text wins
            if let Some(ref text) = entry.user_prompt_text {
                m.last_prompt = Some(text.clone());
            }
            // Track the last user-message timestamp so we can gate the
            // thinking→working promotion against stale prior-turn text.
            if let Some(ts) = entry.timestamp {
                m.last_user_prompt_ts = Some(ts);
            }
            // Last /effort command wins
            if let Some(ref eff) = entry.effort_command {
                m.effort_level = Some(eff.clone());
                m.effort_level_ts = entry.effort_command_ts;
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

            // Latest assistant entry's text-content status wins.
            m.last_assistant_has_text = entry.has_text_content;
            // Record the timestamp of the latest assistant message that
            // actually carried text — pure tool_use / thinking-only messages
            // don't count. Compared against `last_user_prompt_ts` during
            // state promotion so stale prior-turn text can't pop a new
            // UserPromptSubmit straight out of thinking.
            if entry.has_text_content {
                if let Some(ts) = entry.timestamp {
                    m.last_assistant_text_ts = Some(ts);
                }
            }
            // Latest non-empty assistant text wins. Skip entries without text
            // (pure tool_use messages) so the snippet stays on the actual
            // answer the user would have read.
            if let Some(ref txt) = entry.assistant_text {
                m.last_assistant_text = Some(txt.clone());
            }

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
    fn test_parse_effort_command_string_content() {
        let line = r#"{"type":"user","timestamp":1710000010.0,"message":{"role":"user","content":"<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>xhigh</command-args>"}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].effort_command.as_deref(), Some("xhigh"));
    }

    #[test]
    fn test_parse_effort_command_array_content() {
        let line = r#"{"type":"user","timestamp":1710000010.0,"message":{"role":"user","content":[{"type":"text","text":"<command-name>/effort</command-name><command-args>auto</command-args>"}]}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries[0].effort_command.as_deref(), Some("auto"));
    }

    #[test]
    fn test_effort_command_future_level_passes_through() {
        // Unknown future level names survive unchanged.
        let line = r#"{"type":"user","timestamp":1.0,"message":{"role":"user","content":"<command-name>/effort</command-name><command-args>ultra</command-args>"}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries[0].effort_command.as_deref(), Some("ultra"));
    }

    #[test]
    fn test_effort_command_rejects_single_char_arg() {
        // `/effort X` (user typo) would previously render as a literal "x" pill
        // misrepresenting the actual effort level — now rejected so the
        // backend falls back to the global/auto default.
        let line = r#"{"type":"user","timestamp":1.0,"message":{"role":"user","content":"<command-name>/effort</command-name><command-args>X</command-args>"}}"#;
        let entries = parse_jsonl_content(line);
        assert!(entries[0].effort_command.is_none());
    }

    #[test]
    fn test_effort_command_rejects_numeric_arg() {
        let line = r#"{"type":"user","timestamp":1.0,"message":{"role":"user","content":"<command-name>/effort</command-name><command-args>3</command-args>"}}"#;
        let entries = parse_jsonl_content(line);
        assert!(entries[0].effort_command.is_none());
    }

    #[test]
    fn test_non_effort_command_ignored() {
        let line = r#"{"type":"user","timestamp":1.0,"message":{"role":"user","content":"<command-name>/title</command-name><command-args>my title</command-args>"}}"#;
        let entries = parse_jsonl_content(line);
        assert!(entries[0].effort_command.is_none());
    }

    #[test]
    fn test_effort_aggregates_latest_wins() {
        let lines = [
            r#"{"type":"user","timestamp":1.0,"message":{"role":"user","content":"<command-name>/effort</command-name><command-args>low</command-args>"}}"#,
            r#"{"type":"user","timestamp":2.0,"message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"user","timestamp":3.0,"message":{"role":"user","content":"<command-name>/effort</command-name><command-args>high</command-args>"}}"#,
        ].join("\n");
        let tmp = std::env::temp_dir()
            .join(format!("cue_effort_test_{}.jsonl", std::process::id()));
        std::fs::write(&tmp, lines).unwrap();
        let m = parse_jsonl_to_session_metrics(&tmp).unwrap();
        let _ = std::fs::remove_file(&tmp);
        assert_eq!(m.effort_level.as_deref(), Some("high"));
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
    fn test_text_content_block_detected() {
        let line = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":20},"content":[{"type":"text","text":"Hello, world!"}]}}"#;
        let entries = parse_jsonl_content(line);
        assert!(entries[0].has_text_content);
    }

    #[test]
    fn test_thinking_only_block_does_not_count_as_text() {
        // Extended-thinking tokens land in a `thinking` block — must NOT
        // be treated as user-visible text. Otherwise we'd false-positive
        // promote thinking → working while the model is still thinking.
        let line = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":2000},"content":[{"type":"thinking","thinking":"Let me reason about this..."}]}}"#;
        let entries = parse_jsonl_content(line);
        assert!(!entries[0].has_text_content);
    }

    #[test]
    fn test_empty_text_block_does_not_count() {
        let line = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":20},"content":[{"type":"text","text":"   "}]}}"#;
        let entries = parse_jsonl_content(line);
        assert!(!entries[0].has_text_content);
    }

    #[test]
    fn test_thinking_then_text_counts_as_text() {
        // A real response: thinking block followed by text block. Both present.
        let line = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":50},"content":[{"type":"thinking","thinking":"reasoning..."},{"type":"text","text":"Here is my answer."}]}}"#;
        let entries = parse_jsonl_content(line);
        assert!(entries[0].has_text_content);
    }

    #[test]
    fn test_session_metrics_last_assistant_text_status() {
        // Two assistant entries: first has only thinking, second has text.
        // The latest one's status should win.
        let thinking_only = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":1000},"content":[{"type":"thinking","thinking":"..."}]}}"#;
        let with_text = r#"{"type":"assistant","timestamp":2.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":50},"content":[{"type":"text","text":"answer"}]}}"#;

        let dir = std::env::temp_dir().join("cue_test_last_text");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jsonl");
        std::fs::write(&path, format!("{}\n{}", thinking_only, with_text)).unwrap();

        let m = parse_jsonl_to_session_metrics(&path).unwrap();
        assert!(m.last_assistant_has_text);

        let _ = std::fs::remove_dir_all(&dir);
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

}
