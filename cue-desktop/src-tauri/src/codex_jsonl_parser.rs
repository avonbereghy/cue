//! Incremental, bounded parser for Codex rollout JSONL files.
//!
//! Codex's rollout schema is intentionally treated as provider-specific and
//! best-effort: unknown records are ignored, while the stable session_meta,
//! turn_context, response_item, and event_msg families enrich Cue metrics.

use crate::models::{SessionMetrics, SubagentMetrics};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::SystemTime;

const MAX_FILE_SIZE: u64 = 500 * 1024 * 1024;
const MAX_LINE_SIZE: usize = 8 * 1024 * 1024;
const SNIPPET_CAP: usize = 2000;
const TITLE_CAP: usize = 100;
const MAX_SYNTHETIC_SUBAGENTS: i64 = 64;

#[derive(Debug, Clone, Default)]
pub struct CodexJsonlCache {
    pub file_size: u64,
    pub file_mtime: Option<SystemTime>,
    metrics: SessionMetrics,
    pending_calls: HashMap<String, (String, Option<String>, u64)>,
    next_call_order: u64,
}

pub fn parse_codex_jsonl_to_session_metrics_cached(
    path: &Path,
    cache: &mut CodexJsonlCache,
    active_subagents: i64,
) -> Option<SessionMetrics> {
    refresh_cache(path, cache);
    if cache.file_size == 0 && cache.metrics.last_prompt_session_id.is_none() {
        return None;
    }

    cache.metrics.pending_tool_use = !cache.pending_calls.is_empty();
    if let Some((name, target, _)) = cache
        .pending_calls
        .values()
        .max_by_key(|(_, _, order)| *order)
    {
        cache.metrics.running_tool_name = Some(name.clone());
        cache.metrics.running_tool_target = target.clone();
    } else {
        cache.metrics.running_tool_name = None;
        cache.metrics.running_tool_target = None;
    }
    cache.metrics.pending_agent_tool_count = active_subagents.max(0);
    cache.metrics.subagents = synthetic_subagents(active_subagents);
    cache.metrics.parsed_file_mtime = cache
        .file_mtime
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64());
    Some(cache.metrics.clone())
}

fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

fn reset(cache: &mut CodexJsonlCache) {
    cache.file_size = 0;
    cache.metrics = SessionMetrics::default();
    cache.pending_calls.clear();
    cache.next_call_order = 0;
}

fn refresh_cache(path: &Path, cache: &mut CodexJsonlCache) {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            reset(cache);
            cache.file_mtime = None;
            return;
        }
    };
    let size = metadata.len();
    let mtime = metadata.modified().ok();
    if size > MAX_FILE_SIZE {
        reset(cache);
        cache.file_mtime = mtime;
        return;
    }
    let mtime_regressed = matches!(
        (cache.file_mtime, mtime),
        (Some(previous), Some(current)) if current < previous
    );
    if size < cache.file_size || mtime_regressed {
        reset(cache);
    }
    if size == cache.file_size {
        cache.file_mtime = mtime;
        return;
    }

    let mut file = match open_no_follow(path) {
        Ok(file) => file,
        Err(_) => return,
    };
    if file
        .metadata()
        .is_ok_and(|metadata| metadata.len() > MAX_FILE_SIZE)
    {
        reset(cache);
        cache.file_mtime = mtime;
        return;
    }
    if cache.file_size > 0 && file.seek(SeekFrom::Start(cache.file_size)).is_err() {
        reset(cache);
        file = match open_no_follow(path) {
            Ok(file) => file,
            Err(_) => return,
        };
    }

    let remaining = MAX_FILE_SIZE.saturating_sub(cache.file_size);
    let mut buffer = String::new();
    if file
        .take(remaining.saturating_add(1))
        .read_to_string(&mut buffer)
        .is_err()
        || buffer.len() as u64 > remaining
    {
        reset(cache);
        cache.file_mtime = mtime;
        return;
    }
    let consumed = if buffer.ends_with('\n') {
        buffer.len()
    } else {
        match buffer.rfind('\n') {
            Some(index) => index + 1,
            None => {
                cache.file_mtime = mtime;
                return;
            }
        }
    };
    for line in buffer[..consumed].lines() {
        if line.is_empty() || line.len() > MAX_LINE_SIZE {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            apply_record(&value, cache);
        }
    }
    cache.file_size = cache.file_size.saturating_add(consumed as u64);
    cache.file_mtime = mtime;
}

fn apply_record(root: &Value, cache: &mut CodexJsonlCache) {
    let Some(kind) = root.get("type").and_then(Value::as_str) else {
        return;
    };
    let payload = root.get("payload").unwrap_or(&Value::Null);
    let timestamp = record_timestamp(root, payload);
    if let Some(timestamp) = timestamp {
        cache.metrics.last_entry_ts = Some(
            cache
                .metrics
                .last_entry_ts
                .map_or(timestamp, |prior| prior.max(timestamp)),
        );
    }

    match kind {
        "session_meta" => apply_session_meta(payload, &mut cache.metrics),
        "turn_context" => apply_turn_context(payload, &mut cache.metrics),
        "response_item" => apply_response_item(payload, timestamp, cache),
        "event_msg" => apply_event(payload, timestamp, cache),
        _ => {}
    }
}

fn apply_session_meta(payload: &Value, metrics: &mut SessionMetrics) {
    metrics.last_prompt_session_id = payload
        .get("session_id")
        .or_else(|| payload.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(branch) = payload
        .get("git")
        .and_then(|git| git.get("branch"))
        .and_then(Value::as_str)
        .filter(|branch| !branch.is_empty())
    {
        metrics.git_branch = Some(branch.to_string());
    }
}

fn apply_turn_context(payload: &Value, metrics: &mut SessionMetrics) {
    if let Some(model) = payload.get("model").and_then(Value::as_str) {
        metrics.model = model.to_string();
    }
    metrics.effort_level = payload
        .get("effort")
        .and_then(Value::as_str)
        .filter(|effort| !effort.is_empty())
        .map(str::to_string)
        .or_else(|| metrics.effort_level.clone());
}

fn apply_response_item(payload: &Value, timestamp: Option<f64>, cache: &mut CodexJsonlCache) {
    match payload.get("type").and_then(Value::as_str) {
        Some("message") => {
            let role = payload.get("role").and_then(Value::as_str);
            let text = message_text(payload);
            if role == Some("user") {
                if let Some(prompt) = text.and_then(clean_user_prompt) {
                    cache.metrics.user_message_count =
                        cache.metrics.user_message_count.saturating_add(1);
                    cache.metrics.last_prompt = Some(cap(&prompt, SNIPPET_CAP));
                    cache.metrics.last_user_prompt_ts = timestamp;
                    if cache.metrics.custom_title.is_none() {
                        cache.metrics.custom_title = Some(title_from_prompt(&prompt));
                    }
                }
            } else if role == Some("assistant") {
                cache.metrics.message_count = cache.metrics.message_count.saturating_add(1);
                if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
                    cache.metrics.last_assistant_has_text = true;
                    cache.metrics.last_assistant_text = Some(cap(text.trim(), SNIPPET_CAP));
                    cache.metrics.last_assistant_text_ts = timestamp;
                }
            }
        }
        Some("function_call" | "custom_tool_call") => {
            let call_id = payload
                .get("call_id")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str);
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            *cache
                .metrics
                .tool_counts
                .entry(name.to_string())
                .or_insert(0) += 1;
            if let Some(call_id) = call_id {
                cache.next_call_order = cache.next_call_order.saturating_add(1);
                cache.pending_calls.insert(
                    call_id.to_string(),
                    (
                        name.to_string(),
                        tool_target(payload),
                        cache.next_call_order,
                    ),
                );
            }
        }
        Some("function_call_output" | "custom_tool_call_output") => {
            if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                cache.pending_calls.remove(call_id);
            }
            cache.metrics.last_tool_result_ts = timestamp;
        }
        _ => {}
    }
}

fn apply_event(payload: &Value, timestamp: Option<f64>, cache: &mut CodexJsonlCache) {
    match payload.get("type").and_then(Value::as_str) {
        Some("task_started") => {
            update_context_window(payload, &mut cache.metrics);
        }
        Some("token_count") => {
            let Some(info) = payload.get("info") else {
                return;
            };
            update_context_window(info, &mut cache.metrics);
            if let Some(total) = info.get("total_token_usage") {
                cache.metrics.input_tokens = token(total, "input_tokens");
                cache.metrics.output_tokens = token(total, "output_tokens");
                cache.metrics.cache_read_tokens = token(total, "cached_input_tokens");
                cache.metrics.cache_creation_tokens = token(total, "cache_write_input_tokens");
            }
            if let Some(last) = info.get("last_token_usage") {
                cache.metrics.last_input_tokens = token(last, "total_tokens");
            }
        }
        Some("task_complete") => {
            cache.metrics.last_end_turn_ts =
                timestamp.or_else(|| numeric_time(payload, "completed_at"));
            cache.metrics.pending_tool_use = false;
            cache.pending_calls.clear();
            if let Some(text) = payload
                .get("last_agent_message")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
            {
                cache.metrics.last_assistant_text = Some(cap(text.trim(), SNIPPET_CAP));
                cache.metrics.last_assistant_has_text = true;
                cache.metrics.last_assistant_text_ts = cache.metrics.last_end_turn_ts;
            }
        }
        Some("item_completed") => {
            let item = payload.get("item").unwrap_or(&Value::Null);
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or("item");
            if matches!(item_type, "CommandExecution" | "FileChange" | "Extension") {
                cache.metrics.last_tool_result_ts = timestamp;
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    cache.pending_calls.remove(id);
                }
            } else if item_type == "AgentMessage"
                && item.get("phase").and_then(Value::as_str) == Some("final_answer")
            {
                // Current Codex rollouts use an item_completed(final_answer)
                // event as the durable end-of-turn marker (older builds also
                // emitted task_complete, handled above).
                cache.metrics.last_end_turn_ts = timestamp;
                cache.pending_calls.clear();
                if let Some(text) = message_text(item).filter(|text| !text.trim().is_empty()) {
                    cache.metrics.last_assistant_text = Some(cap(text.trim(), SNIPPET_CAP));
                    cache.metrics.last_assistant_has_text = true;
                    cache.metrics.last_assistant_text_ts = timestamp;
                }
            }
        }
        _ => {}
    }
}

fn update_context_window(value: &Value, metrics: &mut SessionMetrics) {
    if let Some(window) = value
        .get("model_context_window")
        .and_then(Value::as_i64)
        .filter(|window| *window > 0)
    {
        metrics.model_context_window = window;
    }
}

fn message_text(payload: &Value) -> Option<&str> {
    payload
        .get("content")?
        .as_array()?
        .iter()
        .find_map(|block| block.get("text").and_then(Value::as_str))
}

fn clean_user_prompt(text: &str) -> Option<String> {
    let mut prompt = text.trim();
    for tag in ["environment_context", "summary"] {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        if prompt.starts_with(&open) {
            prompt = prompt
                .find(&close)
                .map(|index| &prompt[index + close.len()..])
                .unwrap_or("")
                .trim();
        }
    }
    if prompt.is_empty() {
        None
    } else {
        Some(prompt.to_string())
    }
}

fn title_from_prompt(prompt: &str) -> String {
    let first_line = prompt
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(prompt);
    cap(first_line.trim(), TITLE_CAP)
}

fn tool_target(payload: &Value) -> Option<String> {
    let input = payload.get("input").and_then(Value::as_str)?;
    let parsed: Value = serde_json::from_str(input).ok()?;
    parsed
        .get("cmd")
        .or_else(|| parsed.get("command"))
        .or_else(|| parsed.get("path"))
        .and_then(Value::as_str)
        .map(|target| cap(target, 120))
}

fn token(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0).max(0)
}

fn record_timestamp(root: &Value, payload: &Value) -> Option<f64> {
    root.get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_rfc3339)
        .or_else(|| numeric_time(payload, "completed_at"))
        .or_else(|| numeric_time(payload, "started_at"))
        .or_else(|| numeric_time(payload, "completed_at_ms").map(|value| value / 1000.0))
        .or_else(|| numeric_time(payload, "started_at_ms").map(|value| value / 1000.0))
        .or_else(|| {
            payload
                .get("internal_chat_message_metadata_passthrough")
                .and_then(|metadata| numeric_time(metadata, "create_time"))
        })
}

fn numeric_time(value: &Value, field: &str) -> Option<f64> {
    value.get(field).and_then(Value::as_f64)
}

fn parse_rfc3339(value: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp() as f64 + date.timestamp_subsec_nanos() as f64 / 1e9)
}

fn cap(value: &str, limit: usize) -> String {
    let mut output = String::new();
    for (index, character) in value.chars().enumerate() {
        if index == limit {
            output.push('…');
            break;
        }
        output.push(character);
    }
    output
}

fn synthetic_subagents(active: i64) -> Vec<SubagentMetrics> {
    (0..active.clamp(0, MAX_SYNTHETIC_SUBAGENTS))
        .map(|index| SubagentMetrics {
            agent_id: format!("codex-agent-{}", index + 1),
            description: "Codex subagent".to_string(),
            is_active: true,
            ..SubagentMetrics::default()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_metadata_messages_tools_and_tokens_incrementally() {
        let dir = std::env::temp_dir().join(format!("cue_codex_parser_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        let first = concat!(
            "{\"timestamp\":\"2026-08-26T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"same-id\",\"git\":{\"branch\":\"feature\"}}}\n",
            "{\"timestamp\":\"2026-08-26T10:00:01Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6\",\"effort\":\"high\"}}\n",
            "{\"timestamp\":\"2026-08-26T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"model_context_window\":258400}}\n",
            "{\"timestamp\":\"2026-08-26T10:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Build the parser\"}]}}\n",
            "{\"timestamp\":\"2026-08-26T10:00:03Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"exec\",\"input\":\"{\\\"cmd\\\":\\\"cargo test\\\"}\"}}\n"
        );
        std::fs::write(&path, first).unwrap();
        let mut cache = CodexJsonlCache::default();
        let first_metrics =
            parse_codex_jsonl_to_session_metrics_cached(&path, &mut cache, 2).unwrap();
        assert_eq!(
            first_metrics.last_prompt_session_id.as_deref(),
            Some("same-id")
        );
        assert_eq!(first_metrics.model, "gpt-5.6");
        assert_eq!(first_metrics.model_context_window, 258_400);
        assert_eq!(first_metrics.effort_level.as_deref(), Some("high"));
        assert_eq!(
            first_metrics.last_prompt.as_deref(),
            Some("Build the parser")
        );
        assert_eq!(first_metrics.tool_counts.get("exec"), Some(&1));
        assert!(first_metrics.pending_tool_use);
        assert_eq!(first_metrics.subagents.len(), 2);

        let tail = concat!(
            "{\"timestamp\":\"2026-08-26T10:00:04Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"c1\",\"output\":\"ok\"}}\n",
            "{\"timestamp\":\"2026-08-26T10:00:05Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":40,\"cache_write_input_tokens\":2,\"output_tokens\":25},\"last_token_usage\":{\"total_tokens\":77},\"model_context_window\":121600}}}\n",
            "{\"timestamp\":\"2026-08-26T10:00:06Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"completed_at_ms\":1787757606000.0,\"item\":{\"id\":\"final-1\",\"type\":\"AgentMessage\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"Parser complete\"}]}}}\n"
        );
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(tail.as_bytes())
            .unwrap();
        let metrics = parse_codex_jsonl_to_session_metrics_cached(&path, &mut cache, 0).unwrap();
        assert!(!metrics.pending_tool_use);
        assert_eq!(metrics.input_tokens, 100);
        assert_eq!(metrics.cache_read_tokens, 40);
        assert_eq!(metrics.output_tokens, 25);
        assert_eq!(metrics.last_input_tokens, 77);
        assert_eq!(metrics.model_context_window, 121_600);
        assert!(metrics.last_end_turn_ts.is_some());
        assert_eq!(
            metrics.last_assistant_text.as_deref(),
            Some("Parser complete")
        );
        assert!(metrics.subagents.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_malformed_and_partial_records_without_losing_incremental_offset() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("cue_codex_partial_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                "not-json\n",
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"partial-id\"}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt"
            ),
        )
        .unwrap();
        let mut cache = CodexJsonlCache::default();
        let first = parse_codex_jsonl_to_session_metrics_cached(&path, &mut cache, 0).unwrap();
        assert_eq!(first.last_prompt_session_id.as_deref(), Some("partial-id"));
        assert!(first.model.is_empty());

        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"-5.6\"}}\n")
            .unwrap();
        let second = parse_codex_jsonl_to_session_metrics_cached(&path, &mut cache, 0).unwrap();
        assert_eq!(second.model, "gpt-5.6");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_rollout_over_file_cap_without_allocating_it() {
        let dir = std::env::temp_dir().join(format!("cue_codex_huge_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_FILE_SIZE + 1).unwrap();
        let mut cache = CodexJsonlCache::default();
        assert!(parse_codex_jsonl_to_session_metrics_cached(&path, &mut cache, 0).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_rollouts() {
        use std::os::unix::fs::symlink;
        let dir =
            std::env::temp_dir().join(format!("cue_codex_parser_link_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target.jsonl");
        std::fs::write(
            &target,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"x\"}}\n",
        )
        .unwrap();
        let link = dir.join("link.jsonl");
        symlink(&target, &link).unwrap();
        let mut cache = CodexJsonlCache::default();
        assert!(parse_codex_jsonl_to_session_metrics_cached(&link, &mut cache, 0).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
