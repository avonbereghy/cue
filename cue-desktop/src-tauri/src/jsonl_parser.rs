//! Line-by-line JSONL parsing for Claude Code conversation logs.
//!
//! Handles three timestamp formats: Unix f64, ISO 8601 string, isoTimestamp field.
//! Extracts: type, timestamp, usage tokens, tool uses, model, custom title, git branch.

use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Maximum file size we'll parse (500 MB).
const MAX_FILE_SIZE: u64 = 500 * 1024 * 1024;

/// Cap on the last-prompt / last-assistant-text snippets we retain in the
/// in-memory session metrics and ship to the frontend. The UI only shows a
/// short pill inline and an expandable popup — multi-MB messages would bloat
/// memory and cross the IPC boundary unnecessarily.
const SNIPPET_CHAR_CAP: usize = 2000;

/// Truncate `s` to at most `SNIPPET_CHAR_CAP` Unicode scalar values without
/// splitting a multi-byte code point. Appends an ellipsis if truncation ran.
fn cap_snippet(s: &str) -> String {
    let mut end_byte = s.len();
    for (count, (idx, _)) in s.char_indices().enumerate() {
        if count == SNIPPET_CHAR_CAP {
            end_byte = idx;
            break;
        }
    }
    if end_byte < s.len() {
        let mut out = String::with_capacity(end_byte + 1);
        out.push_str(&s[..end_byte]);
        out.push('…');
        out
    } else {
        s.to_string()
    }
}

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
    /// Explicit title — the user's `/title` command or the fork "(Branch)"
    /// marker (`type == "custom-title"`, field `customTitle`). Authoritative.
    pub custom_title: Option<String>,
    /// Auto-generated title Claude Code now writes for nearly every session
    /// (`type == "ai-title"`, field `aiTitle`). Used as a fallback subtitle
    /// only when no explicit `custom_title` survives.
    pub ai_title: Option<String>,
    pub git_branch: Option<String>,
    pub agent_id: Option<String>,
    pub slug: Option<String>,
    /// True if this assistant message has stop_reason "tool_use"
    pub has_pending_tool_use: bool,
    /// True if this assistant message has stop_reason "end_turn" — Claude's
    /// own signal that the turn has finished. Used to demote stuck working/
    /// thinking cards when the Stop hook fails to fire (see session_monitor).
    pub has_end_turn: bool,
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
    /// Error text from an entry flagged `isApiErrorMessage` — the human-readable
    /// reason a turn failed (bad/unavailable model, rate limit, billing, …).
    pub api_error_text: Option<String>,
    /// `id` fields of tool_use blocks in this assistant message whose `name`
    /// is in the user-prompting set (AskUserQuestion, ExitPlanMode). When such
    /// an id has no matching tool_result anywhere in the file, the session is
    /// genuinely blocked on a user-input tool call — that's the only deterministic
    /// "waiting" condition. Permission prompts and idle notifications do *not*
    /// populate this list (they're not user-input tools, they just gate the next
    /// step of an in-progress turn).
    pub prompting_tool_use_ids: Vec<String>,
    /// `tool_use_id` references from tool_result blocks in this user message.
    /// Used to mark prompting tool_uses as resolved when the user has answered.
    pub tool_result_ids: Vec<String>,
    /// `id` fields of subagent-spawning tool_use blocks (Agent / Task) in this
    /// assistant message. An id with no matching tool_result means a foreground
    /// agent batch is still running — the deterministic "subagents in flight"
    /// signal that doesn't depend on file mtimes. Robust to parallel batches
    /// where some agents have already returned their tool_result (the
    /// stop_reason-based `pending_tool_use` flips false at the first result).
    pub agent_tool_use_ids: Vec<String>,
    /// True if this user-type entry is a harness interrupt marker
    /// ("[Request interrupted by user]" / "[Request interrupted by user for
    /// tool use]") rather than a real prompt. Claude Code fires NO hook on
    /// ESC, so this transcript row is the only deterministic evidence the
    /// turn was aborted. Marker entries are excluded from user-message
    /// counting and prompt display, and drive an immediate demote of stuck
    /// working/thinking cards (previously they pinned for the 5-minute
    /// stalled-turn timer and polluted the last-prompt pill).
    pub is_interrupt_marker: bool,
}

/// Prefix of the user-entry text Claude Code writes when the user interrupts
/// a turn (ESC). Covers both observed variants: "[Request interrupted by
/// user]" and "[Request interrupted by user for tool use]".
const INTERRUPT_MARKER_PREFIX: &str = "[Request interrupted by user";

/// Tool names that genuinely block the assistant on user input. An unmatched
/// tool_use with one of these names is the only deterministic signal that the
/// session is "waiting" on the user in the way the dashboard yellow stripes
/// imply. Kept narrow on purpose — permission prompts are *not* in this set.
pub const PROMPTING_TOOL_NAMES: &[&str] = &["AskUserQuestion", "ExitPlanMode"];

/// Tool names that spawn subagents. An unmatched tool_use with one of these
/// names at the transcript tail means a foreground agent batch is in flight —
/// the parent turn is blocked on the agents by definition. "Task" is the
/// legacy name of the Agent tool; both appear in real transcripts depending
/// on Claude Code version.
pub const AGENT_TOOL_NAMES: &[&str] = &["Agent", "Task"];

/// Parse a JSONL file into a list of entries.
/// Returns an empty Vec if the file is too large, unreadable, or empty.
///
/// Reads through `security::read_to_string_bounded`, which opens the file
/// once (with `O_NOFOLLOW` on Unix so a symlink dropped at
/// `~/.claude/projects/<encoded-ws>/<sid>.jsonl` can't redirect this read at
/// e.g. `~/.ssh/id_rsa` and surface its contents through SessionMetrics),
/// enforces the `MAX_FILE_SIZE` cap on that same handle's `fstat`, and bounds
/// the read with `take(max + 1)`. The single-handle policy closes the
/// stat-then-read TOCTOU window a racing writer could otherwise use to swap a
/// small file for a huge one between the size check and the read.
pub fn parse_jsonl_file(path: &Path) -> Vec<ParsedEntry> {
    parse_jsonl_file_opts(path, true)
}

/// Like `parse_jsonl_file` but KEEPS `isSidechain: true` rows. Used only for
/// `subagents/*.jsonl`: those dedicated transcripts are written entirely as
/// sidechain rows, so the default sidechain-drop (correct for the MAIN
/// transcript) would discard every line and the agent would vanish from
/// `m.subagents` — leaving the parent card stuck on `idle` while a background
/// `Agent` batch is in flight. See `parse_line_opts`.
pub fn parse_jsonl_file_keep_sidechain(path: &Path) -> Vec<ParsedEntry> {
    parse_jsonl_file_opts(path, false)
}

fn parse_jsonl_file_opts(path: &Path, drop_sidechain: bool) -> Vec<ParsedEntry> {
    // Drew's bounded read is the superset of Andy's open_jsonl_no_follow + manual
    // size check: `read_to_string_bounded` opens once with O_NOFOLLOW, enforces
    // MAX_FILE_SIZE on that same handle's fstat, and bounds the read — closing the
    // stat-then-read TOCTOU window. Andy's sidechain split is threaded through via
    // `drop_sidechain` (true = MAIN transcript drops isSidechain rows; false =
    // subagent transcript keeps them).
    match crate::security::read_to_string_bounded(path, MAX_FILE_SIZE) {
        Ok(content) => parse_jsonl_content_opts(&content, drop_sidechain),
        Err(e) => {
            if e.kind() == std::io::ErrorKind::FileTooLarge {
                log::warn!("Skipping oversized JSONL file: {:?}", path);
            } else {
                log::debug!("Failed to read JSONL file {:?}: {}", path, e);
            }
            Vec::new()
        }
    }
}

/// Cached parse state for a single JSONL file.
///
/// `file_size` is always advanced to a newline boundary so the next tail-read
/// can `seek` directly to the next complete line. A trailing partial line (no
/// final `\n`) is left for the next refresh — assistant messages can land
/// mid-write and we don't want to parse half a JSON object.
#[derive(Debug, Clone, Default)]
pub struct JsonlEntryCache {
    pub file_size: u64,
    pub file_mtime: Option<SystemTime>,
    pub entries: Vec<ParsedEntry>,
    /// Per-subagent-transcript incremental caches, keyed by the subagent JSONL
    /// path. Only populated on the cached parse path
    /// (`parse_jsonl_to_session_metrics_cached`); the one-shot
    /// `parse_jsonl_to_session_metrics` path leaves this empty and re-reads
    /// each subagent in full. Each nested cache obeys the same tail-read /
    /// truncation / mtime-regression rules as the main transcript. Entries for
    /// subagent files that no longer exist are pruned every refresh so the map
    /// can't grow unbounded across a long-lived session.
    pub subagent_caches: HashMap<PathBuf, JsonlEntryCache>,
}

/// Open a JSONL file for reading, refusing to follow symlinks on Unix. Mirrors
/// the write-path guard in `security::atomic_write` so a symlink dropped in
/// `~/.claude/projects/` can't redirect the reader at e.g. `~/.ssh/known_hosts`.
fn open_jsonl_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    opts.open(path)
}

/// Append newly-written lines from `path` into `cache.entries`. On truncation
/// or a backwards-moving mtime (file replaced/forked) the cache is reset and
/// the file is fully re-read.
///
/// `drop_sidechain` MUST match the transcript kind: `true` for a MAIN
/// transcript (drop `isSidechain: true` rows, so a subagent's noise can't leak
/// into the parent's metrics) and `false` for a subagent transcript under
/// `subagents/` (which is written ENTIRELY as sidechain rows — dropping them
/// would empty the cache, the agent would vanish from `m.subagents`, and the
/// parent card would sit on `idle` for the whole background-Agent run). This is
/// the production 5s-tick path, so the split has to be threaded here too, not
/// just through the one-shot `parse_jsonl_file*` variants.
fn refresh_entry_cache(path: &Path, cache: &mut JsonlEntryCache, drop_sidechain: bool) {
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) => {
            // If the file is gone (session deleted, log cleaned), drop the
            // cached entries so a later poll doesn't keep yielding metrics
            // synthesized from a transcript that no longer exists.
            if e.kind() == std::io::ErrorKind::NotFound {
                cache.file_size = 0;
                cache.entries.clear();
            }
            log::debug!("Failed to stat JSONL file {:?}: {}", path, e);
            return;
        }
    };
    let size = metadata.len();
    let mtime = metadata.modified().ok();

    if size > MAX_FILE_SIZE {
        log::warn!("Skipping oversized JSONL file: {:?} ({} bytes)", path, size);
        cache.file_size = 0;
        cache.file_mtime = mtime;
        cache.entries.clear();
        return;
    }

    let mtime_regressed = matches!(
        (cache.file_mtime, mtime),
        (Some(prev), Some(now)) if now < prev
    );
    if size < cache.file_size || mtime_regressed {
        cache.file_size = 0;
        cache.entries.clear();
    }

    if size == cache.file_size {
        cache.file_mtime = mtime;
        return;
    }

    let mut file = match open_jsonl_no_follow(path) {
        Ok(f) => f,
        Err(e) => {
            log::debug!("Failed to open JSONL file {:?}: {}", path, e);
            return;
        }
    };

    // TOCTOU guard: the `fs::metadata` above is only for change detection
    // (unchanged→skip, truncation, mtime). Re-check the size on the handle we
    // are about to read so a racing writer that swapped in (or grew) a huge
    // file after that stat can't drive an unbounded read. Mirrors the
    // single-handle policy in `security::read_to_string_bounded`.
    if let Ok(handle_md) = file.metadata() {
        if handle_md.len() > MAX_FILE_SIZE {
            log::warn!(
                "Skipping oversized JSONL file: {:?} ({} bytes)",
                path,
                handle_md.len()
            );
            cache.file_size = 0;
            cache.file_mtime = mtime;
            cache.entries.clear();
            return;
        }
    }

    if cache.file_size > 0 {
        if let Err(e) = file.seek(SeekFrom::Start(cache.file_size)) {
            log::debug!("Seek failed on {:?}: {}", path, e);
            cache.file_size = 0;
            cache.entries.clear();
            // Fall through and re-open at offset 0.
            file = match open_jsonl_no_follow(path) {
                Ok(f) => f,
                Err(e2) => {
                    log::debug!("Re-open failed on {:?}: {}", path, e2);
                    return;
                }
            };
        }
    }

    // Bounded tail read on the same handle: capping at MAX_FILE_SIZE + 1 means
    // a file that grew past the cap after the fstat surfaces the extra byte and
    // is rejected without a large allocation. For a well-formed file the tail
    // from `cache.file_size` to EOF is <= MAX_FILE_SIZE, so this reads through
    // verbatim — behavior identical to the previous unbounded `read_to_string`.
    let mut buf = String::new();
    if let Err(e) = file
        .take(MAX_FILE_SIZE.saturating_add(1))
        .read_to_string(&mut buf)
    {
        log::debug!("Read failed on {:?}: {}", path, e);
        return;
    }
    if buf.len() as u64 > MAX_FILE_SIZE {
        log::warn!(
            "Skipping JSONL file that grew past the {} byte cap mid-read: {:?}",
            MAX_FILE_SIZE,
            path
        );
        cache.file_size = 0;
        cache.file_mtime = mtime;
        cache.entries.clear();
        return;
    }

    // Only consume up to the last complete line so we never parse a half-
    // written record. Whatever remains is left for the next refresh.
    let consumed = if buf.ends_with('\n') {
        buf.len()
    } else {
        match buf.rfind('\n') {
            Some(idx) => idx + 1,
            None => {
                // No newline at all — the trailing partial line spans the
                // entire delta; don't advance.
                cache.file_mtime = mtime;
                return;
            }
        }
    };

    for line in buf[..consumed].lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(entry) = parse_line_opts(line, drop_sidechain) {
            cache.entries.push(entry);
        }
    }
    cache.file_size += consumed as u64;
    cache.file_mtime = mtime;
}

/// Parse JSONL content string into entries (MAIN-transcript semantics: drops
/// `isSidechain` rows). For subagent files use `parse_jsonl_file_keep_sidechain`.
pub fn parse_jsonl_content(content: &str) -> Vec<ParsedEntry> {
    parse_jsonl_content_opts(content, true)
}

fn parse_jsonl_content_opts(content: &str, drop_sidechain: bool) -> Vec<ParsedEntry> {
    content
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| parse_line_opts(line, drop_sidechain))
        .collect()
}

/// Parse a single JSONL line. When `drop_sidechain` is true (the MAIN
/// transcript), rows flagged `isSidechain: true` are discarded so a subagent's
/// interleaved turn can't drive the orchestrator card's state. Subagent
/// transcript files (`subagents/*.jsonl`) are written ENTIRELY as sidechain
/// rows, so they MUST be parsed with `drop_sidechain = false` — otherwise every
/// line is dropped, `parse_subagent_jsonl` returns `None`, the agent never
/// lands in `m.subagents`, and a background `Agent` batch shows the parent as
/// idle for its whole run (no hook counter, no unmatched parent tool_use to
/// fall back on).
fn parse_line_opts(line: &str, drop_sidechain: bool) -> Option<ParsedEntry> {
    let json: Value = serde_json::from_str(line).ok()?;
    let obj = json.as_object()?;

    // Drop sidechain entries on the MAIN parse: these belong to a Task subagent's
    // conversation, not the orchestrator's turn. Claude Code writes subagent
    // turns to separate `subagents/*.jsonl` files (parsed independently by
    // `parse_subagent_jsonl`, which passes `drop_sidechain = false`) AND, for
    // some versions / entrypoints, interleaves them into the MAIN transcript
    // flagged `isSidechain: true`. On the main parse, counting them would let a
    // subagent's pending tool_use, end_turn, or AskUserQuestion drive the main
    // card's state (false "working"/"waiting"/idle verdicts). Filtering at the
    // source keeps every downstream signal — pending_tool_use,
    // awaiting_user_prompt, last_end_turn_ts, running tool, assistant text,
    // token totals — scoped to the main conversation. Covers both the full
    // parse and the incremental cache, which share this function.
    if drop_sidechain && obj.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }

    let entry_type = obj.get("type")?.as_str()?.to_string();
    let mut entry = ParsedEntry {
        entry_type: entry_type.clone(),
        ..Default::default()
    };

    // Extract timestamp — try multiple formats
    entry.timestamp = extract_timestamp(obj);

    // Claude Code flags an API-level failure turn (unavailable model, rate
    // limit, billing, …) with a top-level `isApiErrorMessage: true`; the
    // human-readable reason is the message's text block. Capture it so error
    // cards can explain themselves instead of just saying "Error".
    let is_api_error = obj.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true);

    // Extract custom title. Claude Code's branch/fork feature seeds the
    // customTitle with the originating user message's raw text, which can
    // include slash-command XML wrappers (<command-message>.../</command-args>),
    // ANSI escapes, or [Image #N] bracket markers. Apply the same sanitization
    // as user_prompt_text so the subtitle never leaks raw harness markup.
    // Same sanitization for both title sources, since the auto `ai-title` can
    // also echo command markup from the first user turn.
    let sanitize_title = |raw: &str| -> Option<String> {
        let s = strip_ansi_escapes(raw);
        let s = strip_xml_tags(&s);
        let s = strip_bracket_markers(&s);
        let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
        Some(s).filter(|s| !s.is_empty())
    };
    if entry_type == "custom-title" {
        entry.custom_title = obj
            .get("customTitle")
            .and_then(|v| v.as_str())
            .and_then(&sanitize_title);
    } else if entry_type == "ai-title" {
        // Current Claude Code writes the session's auto-generated title as its
        // own `{"type":"ai-title","aiTitle":"..."}` entry (168 of 169 titled
        // live transcripts use this; only the explicit `/title` path still
        // emits `custom-title`). Read it as a fallback so the UI subtitle isn't
        // blank for nearly every session.
        entry.ai_title = obj
            .get("aiTitle")
            .and_then(|v| v.as_str())
            .and_then(&sanitize_title);
    }

    // Extract session ID from metadata entries (permission-mode or system headers)
    if let Some(sid) = obj.get("sessionId").and_then(|v| v.as_str()) {
        entry.jsonl_session_id = Some(sid.to_string());
    }

    // Extract team agent metadata (present on every entry for team-spawned sessions)
    entry.team_name = obj
        .get("teamName")
        .and_then(|v| v.as_str())
        .map(String::from);
    entry.agent_name = obj
        .get("agentName")
        .and_then(|v| v.as_str())
        .map(String::from);

    // Track git branch from any message that has it
    if let Some(branch) = obj.get("gitBranch").and_then(|v| v.as_str()) {
        if branch != "HEAD" {
            entry.git_branch = Some(branch.to_string());
        }
    }

    // Extract agent identifiers (for subagent JSONL files)
    entry.agent_id = obj
        .get("agentId")
        .and_then(|v| v.as_str())
        .map(String::from);
    entry.slug = obj.get("slug").and_then(|v| v.as_str()).map(String::from);

    // Count user messages and extract prompt text.
    //
    // Only entries that carry an actual prompt (extractable text in
    // `message.content`) are flagged as user messages. Claude Code also emits
    // `type: "user"` entries for tool_result payloads and bare metadata rows
    // (gitBranch markers, idle_notification events, etc.) — treating those as
    // user messages inflated `user_message_count` on every tool call, which
    // downstream code used as a "new turn" signal and reset per-turn state
    // (e.g. the signal-string deploy counter) mid-turn.
    if entry_type == "user" {
        entry.user_prompt_text = extract_user_prompt_text(obj);
        entry.effort_command = extract_effort_command(obj);
        if entry.effort_command.is_some() {
            entry.effort_command_ts = entry.timestamp;
        }
        // Interrupt markers are harness rows, not prompts: don't let them
        // count as user messages (they'd reset the end_turn scan boundary and
        // surface as the "last prompt") — record them as the abort signal.
        if entry
            .user_prompt_text
            .as_deref()
            .is_some_and(|t| t.starts_with(INTERRUPT_MARKER_PREFIX))
        {
            entry.is_interrupt_marker = true;
            entry.user_prompt_text = None;
        }
        entry.is_user_message = entry.user_prompt_text.is_some();

        // Scan content blocks for tool_result references. Claude Code packs
        // tool_results inside `type:"user"` entries with `content[].type ==
        // "tool_result"` (see test_tool_result_user_entry_not_counted). Capture
        // every referenced tool_use_id so the aggregator can resolve matching
        // prompting tool_uses. Also flip the legacy `is_tool_result` flag here
        // since the `entry_type == "tool_result"` branch below never fires in
        // real JSONL.
        if let Some(message) = obj.get("message").and_then(|v| v.as_object()) {
            if let Some(content) = message.get("content").and_then(|v| v.as_array()) {
                for block in content {
                    if let Some(block_obj) = block.as_object() {
                        if block_obj.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                            entry.is_tool_result = true;
                            if let Some(tuid) =
                                block_obj.get("tool_use_id").and_then(|v| v.as_str())
                            {
                                entry.tool_result_ids.push(tuid.to_string());
                            }
                        }
                    }
                }
            }
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
                                        // Cap at parse time: aggregate_entries
                                        // only ever ships this through
                                        // cap_snippet, so storing the full body
                                        // per cached entry just bloats memory
                                        // over a long-running session.
                                        entry.assistant_text = Some(cap_snippet(trimmed));
                                    }
                                    if is_api_error && entry.api_error_text.is_none() {
                                        entry.api_error_text = Some(cap_snippet(trimmed));
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

                                // Record user-prompting tool_uses for the
                                // awaiting_user_prompt verdict. Only the id is
                                // needed — the matching tool_result references
                                // it via tool_use_id.
                                if PROMPTING_TOOL_NAMES.contains(&name) {
                                    if let Some(id) = block_obj.get("id").and_then(|v| v.as_str()) {
                                        entry.prompting_tool_use_ids.push(id.to_string());
                                    }
                                }

                                // Record agent-spawning tool_uses for the
                                // subagents-in-flight verdict (same unmatched-
                                // id mechanism as the prompting tools).
                                if AGENT_TOOL_NAMES.contains(&name) {
                                    if let Some(id) = block_obj.get("id").and_then(|v| v.as_str()) {
                                        entry.agent_tool_use_ids.push(id.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Detect pending tool use (session is waiting for permission/input)
            match message.get("stop_reason").and_then(|v| v.as_str()) {
                Some("tool_use") => entry.has_pending_tool_use = true,
                Some("end_turn") => entry.has_end_turn = true,
                _ => {}
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
                    entry
                        .task_status_updates
                        .push((task_id.to_string(), normalized.to_string()));
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

    // Cap to the snippet limit (the field doc already promises "truncated").
    // The interrupt-marker prefix check and aggregate's cap_snippet both work
    // on the capped value; storing the full prompt per cached entry only bloats
    // memory over a long session.
    Some(cap_snippet(trimmed))
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

/// Crash backstop for subagent liveness: an agent whose transcript tail never
/// reached `end_turn` (killed process, harness crash) would otherwise count as
/// active forever. 10 minutes of total transcript silence on an unfinished
/// agent is the flagged last-resort timer — every deterministic signal
/// (tail end_turn, parent's unmatched Agent tool_use) is consumed first.
const SUBAGENT_BACKSTOP_SECS: u64 = 600;

/// Parse a subagent JSONL file and its companion .meta.json into SubagentMetrics.
///
/// One-shot path: reads the whole transcript every call. The incremental
/// counterpart used by the 5s metrics tick is `parse_subagent_jsonl_cached`.
pub fn parse_subagent_jsonl(jsonl_path: &Path) -> Option<crate::models::SubagentMetrics> {
    // KEEP sidechain rows: a subagent transcript is written entirely as
    // `isSidechain: true` rows. The default (main-transcript) parse drops them,
    // which would empty `entries` here and make the agent invisible.
    let entries = parse_jsonl_file_keep_sidechain(jsonl_path);
    if entries.is_empty() {
        return None;
    }
    let mtime = std::fs::metadata(jsonl_path)
        .and_then(|meta| meta.modified())
        .ok();
    subagent_metrics_from_entries(&entries, mtime, jsonl_path)
}

/// Incremental variant of [`parse_subagent_jsonl`]: tails only newly-appended
/// lines via `cache` so an unchanged subagent transcript is neither re-read nor
/// re-parsed on each poll. The cache carries the same correctness guarantees as
/// the main transcript — a truncated or replaced (mtime-regressed) subagent
/// file invalidates the cache and forces a full re-read rather than serving
/// stale entries (see `refresh_entry_cache`). The `mtime` used for the crash
/// backstop is the one the refresh reflects (`cache.file_mtime`), so a stale
/// stat can't extend an agent's liveness.
fn parse_subagent_jsonl_cached(
    jsonl_path: &Path,
    cache: &mut JsonlEntryCache,
) -> Option<crate::models::SubagentMetrics> {
    // KEEP sidechain rows: a subagent transcript is written entirely as
    // `isSidechain: true`, so dropping them here (as the main path does) would
    // empty the cache and make the background Agent invisible on the hot path.
    refresh_entry_cache(jsonl_path, cache, false);
    if cache.entries.is_empty() {
        return None;
    }
    subagent_metrics_from_entries(&cache.entries, cache.file_mtime, jsonl_path)
}

/// Aggregate a subagent's parsed entries (+ its file mtime for the liveness
/// backstop) into `SubagentMetrics`, then enrich with the companion .meta.json.
/// Shared by the one-shot and cached subagent parse paths so both compute
/// liveness and metrics identically.
fn subagent_metrics_from_entries(
    entries: &[ParsedEntry],
    mtime: Option<SystemTime>,
    jsonl_path: &Path,
) -> Option<crate::models::SubagentMetrics> {
    if entries.is_empty() {
        return None;
    }

    // Liveness is transcript-state, not recency: a finished agent's LAST
    // assistant entry carries stop_reason == "end_turn" (verified across live
    // agent transcripts), while a running agent's tail is a tool_use/result
    // mid-turn. The previous "mtime within 60s" check misread every long tool
    // call (real agents show 71–167s silent gaps) as "agent gone", flapping
    // the parent card subagent→idle→subagent for the whole run. The mtime
    // window survives only as a crash backstop for agents that never finish.
    let tail_finished = entries
        .iter()
        .rev()
        .find(|e| e.is_assistant_message)
        .is_some_and(|e| e.has_end_turn);
    let within_backstop = mtime
        .and_then(|mod_time| mod_time.elapsed().ok())
        .map(|elapsed| elapsed.as_secs() < SUBAGENT_BACKSTOP_SECS)
        .unwrap_or(false);
    let is_active = !tail_finished && within_backstop;

    let mut m = crate::models::SubagentMetrics {
        is_active,
        ..Default::default()
    };

    // Extract agentId and slug from first entry that has them
    for entry in entries {
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
    for entry in entries {
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
            m.input_tokens = m.input_tokens.saturating_add(entry.input_tokens);
            m.output_tokens = m.output_tokens.saturating_add(entry.output_tokens);
            m.cache_creation_tokens = m
                .cache_creation_tokens
                .saturating_add(entry.cache_creation_tokens);
            m.cache_read_tokens = m.cache_read_tokens.saturating_add(entry.cache_read_tokens);
            // Latest non-empty assistant text wins — skip pure tool_use messages
            // so the snippet stays on the agent's actual prose (its in-flight
            // output while active, its final result once done). Same cap_snippet
            // bound as the main-session extraction.
            if let Some(ref txt) = entry.assistant_text {
                m.last_assistant_text = Some(cap_snippet(txt));
            }
            for (tool, count) in &entry.tool_counts {
                *m.tool_counts.entry(tool.clone()).or_insert(0) += count;
            }
        }
    }

    // Currently-running tool: scan backwards for the last assistant tool_use
    // with no subsequent tool_result — the same pending-tool detection the
    // main-session parse uses. Only populated while the agent is mid-turn; a
    // finished agent's tail is a tool_result or end_turn text, so both fields
    // stay None.
    for entry in entries.iter().rev() {
        if entry.is_tool_result {
            break;
        }
        if entry.has_pending_tool_use {
            m.running_tool_name = entry.running_tool_name.clone();
            m.running_tool_target = entry.running_tool_target.clone();
            break;
        }
    }

    // Read companion .meta.json for description.
    //
    // Same untrusted-directory rules as the JSONL itself: anyone able to
    // drop a symlink under ~/.claude/projects/.../subagents/ could redirect
    // this read at an arbitrary file, and the `description` we'd surface to
    // the frontend would leak the first 256 bytes of whatever JSON happens
    // to parse out of it. Open with O_NOFOLLOW and cap the read at 256 KiB
    // (real meta files are < 1 KiB; this is just an OOM guard).
    if let Some(stem) = jsonl_path.file_stem().and_then(|s| s.to_str()) {
        let meta_filename = format!("{}.meta.json", stem);
        if let Some(parent) = jsonl_path.parent() {
            let meta_path = parent.join(meta_filename);
            const META_MAX_BYTES: u64 = 256 * 1024;
            // Single-handle bounded read (O_NOFOLLOW + fstat + take): a
            // stat-then-read pair leaves a TOCTOU window where a racing writer
            // could swap a small meta file for a huge one — or a symlink —
            // between the size check and the read. `read_to_string_bounded`
            // opens once and enforces the cap on that same handle. Any error
            // (missing/oversized/non-UTF-8) leaves the default empty
            // description, exactly as before.
            if let Ok(content) = crate::security::read_to_string_bounded(&meta_path, META_MAX_BYTES)
            {
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
    // No cache on the one-shot path: subagents are re-read in full.
    aggregate_entries(&entries, path, None)
}

/// Same as `parse_jsonl_to_session_metrics`, but tails new lines incrementally
/// using `cache` so unchanged sessions skip the read and long-running sessions
/// skip re-parsing every prior line on each poll.
pub fn parse_jsonl_to_session_metrics_cached(
    path: &Path,
    cache: &mut JsonlEntryCache,
) -> Option<crate::models::SessionMetrics> {
    // MAIN transcript: drop `isSidechain: true` rows so a subagent's noise can't
    // leak into the parent session's metrics. Subagent transcripts are tailed
    // separately (with keep-sidechain) inside `aggregate_entries`.
    refresh_entry_cache(path, cache, true);
    // Borrow the main entries immutably and the per-subagent caches mutably —
    // disjoint fields of `cache`, so the split borrow is sound. The subagent
    // discovery inside `aggregate_entries` tails each subagent transcript
    // through its own nested cache instead of re-reading it every tick.
    let mut m = aggregate_entries(&cache.entries, path, Some(&mut cache.subagent_caches))?;
    // Stamp the transcript file mtime this parse reflects so the turn-ended
    // demote can tell a genuinely-idle session (file unchanged since the last
    // end_turn) from a resumed/stale-bumped one where stateChangedAt jumped
    // ahead of the end_turn without a new turn.
    m.parsed_file_mtime = cache
        .file_mtime
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64());
    Some(m)
}

fn aggregate_entries(
    entries: &[ParsedEntry],
    path: &Path,
    // Per-subagent incremental caches, threaded from the caller's
    // `JsonlEntryCache`. `Some` on the cached poll path (subagents are tailed
    // incrementally and pruned when their files vanish); `None` on the one-shot
    // path (each subagent re-read in full).
    mut subagent_caches: Option<&mut HashMap<PathBuf, JsonlEntryCache>>,
) -> Option<crate::models::SessionMetrics> {
    if entries.is_empty() {
        return None;
    }

    let mut m = crate::models::SessionMetrics::default();
    // Auto title fallback, resolved into `custom_title` after the loop only if
    // no explicit `custom-title` (and no branch) claims the subtitle.
    let mut ai_title: Option<String> = None;

    for entry in entries {
        // Session ID from JSONL metadata — first occurrence wins
        if m.last_prompt_session_id.is_none() {
            if let Some(ref sid) = entry.jsonl_session_id {
                m.last_prompt_session_id = Some(sid.clone());
            }
        }

        // Custom title — last one wins. Explicit `custom-title` is
        // authoritative; the auto `ai-title` is held aside as a fallback.
        if let Some(ref title) = entry.custom_title {
            m.custom_title = Some(title.clone());
        }
        if let Some(ref title) = entry.ai_title {
            ai_title = Some(title.clone());
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

        // Interrupt markers: last one wins. Recorded outside the
        // is_user_message branch since markers are deliberately not counted
        // as user messages.
        if entry.is_interrupt_marker {
            if let Some(ts) = entry.timestamp {
                m.last_interrupt_ts = Some(ts);
            }
        }

        // Tool results: last one wins. Feeds the stalled-turn cap as
        // proof-of-life for text-quiet turns (see SessionMetrics doc).
        if entry.is_tool_result {
            if let Some(ts) = entry.timestamp {
                m.last_tool_result_ts = Some(ts);
            }
        }

        if entry.is_user_message {
            m.user_message_count += 1;
            // Last user prompt text wins. Snippet is capped to keep
            // oversized pastes from bloating the IPC payload and the
            // frontend PromptPopup — UI only renders a short preview
            // anyway.
            if let Some(ref text) = entry.user_prompt_text {
                m.last_prompt = Some(cap_snippet(text));
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

            m.input_tokens = m.input_tokens.saturating_add(entry.input_tokens);
            m.output_tokens = m.output_tokens.saturating_add(entry.output_tokens);
            m.cache_creation_tokens = m
                .cache_creation_tokens
                .saturating_add(entry.cache_creation_tokens);
            m.cache_read_tokens = m.cache_read_tokens.saturating_add(entry.cache_read_tokens);

            // Context usage = input tokens + output tokens for the last message
            // (output tokens become part of conversation history for the next turn)
            m.last_input_tokens = entry
                .input_tokens
                .saturating_add(entry.cache_creation_tokens)
                .saturating_add(entry.cache_read_tokens)
                .saturating_add(entry.output_tokens);

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
            // answer the user would have read. Same snippet cap as the
            // prompt — multi-MB assistant responses are clipped.
            if let Some(ref txt) = entry.assistant_text {
                m.last_assistant_text = Some(cap_snippet(txt));
            }
            // The latest assistant turn drives the error reason: an
            // isApiErrorMessage entry sets it, and any normal assistant turn
            // after it means the session recovered — clear the stale reason so an
            // error card only ever shows the current failure.
            if let Some(ref err) = entry.api_error_text {
                m.last_error_message = Some(cap_snippet(err));
            } else {
                m.last_error_message = None;
            }

            for (tool, count) in &entry.tool_counts {
                *m.tool_counts.entry(tool.clone()).or_insert(0) += count;
            }
        }
    }

    // Detect pending tool_use: scan backwards from end to find if the last
    // assistant message with tool_use has no subsequent tool_result.
    // This indicates the session is waiting for permission/user input.
    // Simultaneously capture `last_end_turn_ts` from the same scan — the last
    // assistant message (going backward) that has stop_reason=end_turn AND no
    // newer pending tool_use is the ground-truth "turn finished" signal.
    let mut saw_pending_tool_use = false;
    for entry in entries.iter().rev() {
        if entry.is_tool_result {
            // A tool_result was found before any pending assistant — not waiting
            break;
        }
        if entry.has_pending_tool_use {
            m.pending_tool_use = true;
            m.running_tool_name = entry.running_tool_name.clone();
            m.running_tool_target = entry.running_tool_target.clone();
            saw_pending_tool_use = true;
            break;
        }
        // Skip non-relevant entries (e.g., progress, thinking)
    }
    if !saw_pending_tool_use {
        // No pending tool_use at the tail. Find the newest assistant message
        // with end_turn. We only trust it if nothing newer is a pending
        // tool_use (already handled above) or a user prompt starting a new
        // turn — that user-prompt check is deferred to session_monitor where
        // `stateChangedAt` encodes the same boundary.
        for entry in entries.iter().rev() {
            if entry.has_end_turn {
                m.last_end_turn_ts = entry.timestamp;
                break;
            }
            // Stop at the first user prompt: anything older belongs to a
            // previous turn and doesn't reflect current state.
            if entry.is_user_message {
                break;
            }
        }
    }

    // Awaiting-user-prompt verdict: does any prompting tool_use
    // (AskUserQuestion / ExitPlanMode) exist without a matching
    // tool_result? This runs regardless of `saw_pending_tool_use` because
    // AskUserQuestion *is itself* a stop_reason=tool_use entry — it would
    // always be eclipsed if gated behind that flag. Build the set of
    // resolved tool_use_ids and check every prompting id against it. This is
    // the only deterministic signal for state="waiting"; permission prompts
    // and idle notifications intentionally do not pin state anymore.
    let resolved: std::collections::HashSet<&str> = entries
        .iter()
        .flat_map(|e| e.tool_result_ids.iter().map(String::as_str))
        .collect();
    // A prompting tool_use (AskUserQuestion / ExitPlanMode) pins state="waiting"
    // ONLY while it is the newest turn-relevant event. Claude Code does not
    // always write a tool_result for an ANSWERED AskUserQuestion, so the
    // resolved-id check alone can't distinguish "answered" from "still open":
    // an abandoned/superseded prompt — the assistant went on to run more tools,
    // write prose, or end the turn; the turn was interrupted; or the user sent a
    // new message — would otherwise pin the card on "waiting" indefinitely
    // (observed: a card stuck "awaiting you" for hours while the session had
    // long since moved on). So take the LAST unresolved prompt and clear it if
    // any turn-advancing entry follows it. A genuinely-open prompt IS the tail —
    // only the timestampless last-prompt/ai-title/mode metadata rows come after
    // it, and none of those are turn-advancing.
    let last_open_prompt = entries.iter().enumerate().rev().find_map(|(i, e)| {
        e.prompting_tool_use_ids
            .iter()
            .any(|id| !resolved.contains(id.as_str()))
            .then_some(i)
    });
    m.awaiting_user_prompt = match last_open_prompt {
        None => false,
        Some(p) => !entries.iter().skip(p + 1).any(|e| {
            // "Moved on" = a NEW assistant message (it continued: tool_use or
            // prose), the turn ended, it was interrupted, or the user sent a new
            // message. Deliberately NOT a bare tool_result: if a question were
            // ever batched with another tool, that tool finishing while the
            // question is still open must not clear it (the answer itself, when
            // recorded, resolves the prompt id via `resolved` above, or arrives
            // as a user message caught here).
            e.has_pending_tool_use
                || e.has_text_content
                || e.has_end_turn
                || e.is_interrupt_marker
                || e.user_prompt_text.is_some()
        }),
    };

    // Subagents-in-flight verdict: count Agent/Task tool_uses with no matching
    // tool_result. While > 0, a foreground agent batch is running — regardless
    // of how quiet the agent JSONLs are (long tool calls inside an agent leave
    // its transcript silent for minutes). This is the deterministic signal the
    // mtime-window check can't provide; `should_demote_stale_subagent` and the
    // subagent rescue both consume it.
    m.pending_agent_tool_count = entries
        .iter()
        .flat_map(|e| e.agent_tool_use_ids.iter())
        .filter(|id| !resolved.contains(id.as_str()))
        .count() as i64;

    // Freshness marker: the newest entry timestamp this parse reflects. The
    // waiting verdict gates its demote on this so a hook-seeded `waiting` card
    // isn't dropped to idle while the metrics still predate the dialog opening.
    m.last_entry_ts = entries
        .iter()
        .filter_map(|e| e.timestamp)
        .fold(None, |acc, t| Some(acc.map_or(t, |a: f64| a.max(t))));

    // Todo items: accumulate from all entries.
    // TodoWrite (bulk_replace=true) replaces the entire list.
    // TaskCreate (bulk_replace=false) appends incrementally.
    // TaskUpdate status changes are applied after accumulation.
    for entry in entries {
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

    // Detect Claude Code's branch/fork feature: when a session is forked,
    // the new file inherits the parent's entries (carrying the parent's
    // sessionId) and gains a custom-title row whose customTitle ends with
    // "(Branch)" (Claude Code appends the marker after the seeded prompt).
    // Replace the inherited-prompt customTitle with the parent session ID so
    // the subtitle reads "Branch from <id>" instead of leaking the original
    // user message.
    if let Some(ref title) = m.custom_title {
        if title.trim_end().ends_with("(Branch)") {
            let file_sid = path.file_stem().and_then(|s| s.to_str());
            let parent_sid = entries
                .iter()
                .filter_map(|e| e.jsonl_session_id.as_deref())
                .find(|sid| Some(*sid) != file_sid)
                .map(String::from);
            if let Some(pid) = parent_sid {
                m.branched_from_session_id = Some(pid);
                m.custom_title = None;
            }
        }
    }

    // Fall back to the auto-generated title only when no explicit title claimed
    // the subtitle and this isn't a branch (a branch renders "Branch from <id>"
    // via `branched_from_session_id`, so it must not show a stale auto title).
    if m.custom_title.is_none() && m.branched_from_session_id.is_none() {
        m.custom_title = ai_title;
    }

    // Discover subagents: {session_stem}/subagents/*.jsonl
    if let Some(parent_dir) = path.parent() {
        if let Some(session_stem) = path.file_stem().and_then(|s| s.to_str()) {
            let subagents_dir = parent_dir.join(session_stem).join("subagents");
            // Track which subagent files we saw this pass so stale cache
            // entries (deleted agents) can be pruned. `listed` gates the prune:
            // a transient `read_dir` error must NOT wipe live caches, but an
            // absent directory (`is_dir` false) is authoritative — every
            // subagent is gone, so those caches should clear.
            let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
            let mut listed = false;
            if subagents_dir.is_dir() {
                if let Ok(dir_entries) = std::fs::read_dir(&subagents_dir) {
                    listed = true;
                    for dir_entry in dir_entries.flatten() {
                        let file_path = dir_entry.path();
                        if file_path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                            let sub_metrics = match subagent_caches {
                                Some(ref mut caches) => {
                                    seen.insert(file_path.clone());
                                    let sub_cache = caches.entry(file_path.clone()).or_default();
                                    parse_subagent_jsonl_cached(&file_path, sub_cache)
                                }
                                None => parse_subagent_jsonl(&file_path),
                            };
                            if let Some(sub_metrics) = sub_metrics {
                                m.subagents.push(sub_metrics);
                            }
                        }
                    }
                }
                // Sort by description for stable display order
                m.subagents
                    .sort_by(|a, b| a.description.cmp(&b.description));
            } else {
                // No subagents directory: authoritative "none present".
                listed = true;
            }

            // Evict caches for subagent files that are no longer present so the
            // map is bounded by the live agent count, not the session's history.
            if listed {
                if let Some(ref mut caches) = subagent_caches {
                    caches.retain(|k, _| seen.contains(k));
                }
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

    const USER_MESSAGE: &str =
        r#"{"type":"user","timestamp":1710000001.0,"message":{"role":"user","content":"hello"}}"#;

    const CUSTOM_TITLE: &str =
        r#"{"type":"custom-title","timestamp":1710000002.0,"customTitle":"Auth Refactor"}"#;

    const ISO_TIMESTAMP: &str = r#"{"type":"assistant","isoTimestamp":"2024-03-10T12:00:00Z","message":{"model":"claude-opus-4-6","usage":{"input_tokens":2000,"output_tokens":1000},"content":[]}}"#;

    const GIT_BRANCH: &str =
        r#"{"type":"user","timestamp":1710000003.0,"gitBranch":"feat/dashboard"}"#;

    const MALFORMED: &str = r#"{"type":invalid json here"#;

    #[cfg(unix)]
    #[test]
    fn test_parse_jsonl_file_refuses_to_follow_symlink() {
        // Threat: ~/.claude/projects/<encoded-ws>/<sid>.jsonl is dropped as a
        // symlink to ~/.ssh/id_rsa (or any user-readable file). Without
        // O_NOFOLLOW the parser would read the target and surface its
        // contents through SessionMetrics. With O_NOFOLLOW the open errors
        // out and we return an empty Vec.
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir().join("cue_test_parse_jsonl_symlink");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Real file with one valid JSONL line — the symlink target.
        let victim = dir.join("victim.jsonl");
        std::fs::write(&victim, USER_MESSAGE.to_string() + "\n").unwrap();

        // Symlink at the path parse_jsonl_file is about to open.
        let link = dir.join("session.jsonl");
        symlink(&victim, &link).unwrap();

        let entries = parse_jsonl_file(&link);
        assert!(
            entries.is_empty(),
            "symlink at JSONL path must not be followed; got {} entries",
            entries.len()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_jsonl_file_reads_regular_file() {
        // Sanity check: the no-follow open still works on a normal file.
        let dir = std::env::temp_dir().join("cue_test_parse_jsonl_regular");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("session.jsonl");
        let body = format!("{}\n{}\n", USER_MESSAGE, ASSISTANT_WITH_USAGE);
        std::fs::write(&path, body).unwrap();

        let entries = parse_jsonl_file(&path);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].entry_type, "user");
        assert_eq!(entries[1].entry_type, "assistant");

        let _ = std::fs::remove_dir_all(&dir);
    }

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

    /// F-reliability-003: long message bodies are capped to the snippet limit
    /// at parse time so a marathon session's cached entries don't grow RAM with
    /// the full transcript. Behavior-preserving: aggregate already cap_snippets
    /// these, so the visible value is unchanged.
    #[test]
    fn test_long_text_capped_at_parse_time() {
        let big = "x".repeat(50_000);
        let user = format!(
            r#"{{"type":"user","timestamp":1.0,"message":{{"role":"user","content":"{big}"}}}}"#
        );
        let assistant = format!(
            r#"{{"type":"assistant","timestamp":2.0,"message":{{"role":"assistant","stop_reason":"end_turn","content":[{{"type":"text","text":"{big}"}}],"usage":{{"input_tokens":1}}}}}}"#
        );
        let u = parse_line_opts(&user, true).expect("user entry");
        let a = parse_line_opts(&assistant, true).expect("assistant entry");
        // Capped well under the 50k input (SNIPPET_CHAR_CAP + ellipsis).
        let ulen = u.user_prompt_text.as_ref().unwrap().chars().count();
        let alen = a.assistant_text.as_ref().unwrap().chars().count();
        assert!(
            ulen <= SNIPPET_CHAR_CAP + 1,
            "user prompt not capped: {ulen}"
        );
        assert!(
            alen <= SNIPPET_CHAR_CAP + 1,
            "assistant text not capped: {alen}"
        );
    }

    /// Regression: tool_result entries are `type: "user"` in Claude Code JSONL,
    /// but they carry no prompt text. They must NOT be flagged as user messages
    /// — otherwise `user_message_count` increments on every tool call mid-turn,
    /// which downstream code uses as a new-turn signal and resets per-turn
    /// state (signal-string deploy counter, token-usage rollups, etc.).
    #[test]
    fn test_tool_result_user_entry_not_counted() {
        let tool_result = r#"{"type":"user","timestamp":1710000004.0,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"abc","content":"ok"}]}}"#;
        let entries = parse_jsonl_content(tool_result);
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].is_user_message);
        assert!(entries[0].user_prompt_text.is_none());
    }

    /// Regression: bare metadata-only `type: "user"` entries (gitBranch markers,
    /// idle_notification events, harness-injected ANSI messages) must not count
    /// as user prompts either.
    #[test]
    fn test_metadata_user_entry_not_counted() {
        let entries = parse_jsonl_content(GIT_BRANCH);
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].is_user_message);
    }

    #[test]
    fn test_parse_custom_title() {
        let entries = parse_jsonl_content(CUSTOM_TITLE);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].custom_title.as_deref(), Some("Auth Refactor"));
    }

    /// Regression: Claude Code's fork-session feature can seed customTitle
    /// with the raw text of the originating user message — including
    /// slash-command XML wrappers like `<command-message>…</command-message>
    /// <command-name>/research</command-name> <command-args>…`. The subtitle
    /// pipeline strips these at ingest so they never reach the UI.
    #[test]
    fn test_custom_title_strips_slash_command_wrappers() {
        let line = r#"{"type":"custom-title","customTitle":"<command-message>research</command-message> <command-name>/research</command-name> <command-args>the (Branch)","sessionId":"s1"}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(
            entries[0].custom_title.as_deref(),
            Some("research /research the (Branch)")
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
        assert_eq!(entries[0].git_branch.as_deref(), Some("feat/dashboard"));
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
        let tmp =
            std::env::temp_dir().join(format!("cue_effort_test_{}.jsonl", std::process::id()));
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
        // Only USER_MESSAGE counts — GIT_BRANCH is a metadata-only user entry
        // with no prompt text, so it's excluded from user_message_count.
        assert_eq!(metrics.user_message_count, 1);
        assert_eq!(metrics.message_count, 2); // two assistant messages
        assert_eq!(metrics.input_tokens, 3000); // 1000 + 2000
        assert_eq!(metrics.output_tokens, 1500); // 500 + 1000
        assert_eq!(metrics.custom_title.as_deref(), Some("Auth Refactor"));
        assert_eq!(metrics.git_branch.as_deref(), Some("feat/dashboard"));
        assert_eq!(metrics.model, "claude-opus-4-6"); // last model wins

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Branched/forked sessions: Claude Code seeds the customTitle with the
    /// originating user message + " (Branch)" suffix, and inherited entries
    /// retain the parent's sessionId. The parser must replace the inherited
    /// prompt text with the parent session ID and clear customTitle so the
    /// UI renders "Branch from <id>" instead of leaking user input.
    #[test]
    fn test_branched_session_detection() {
        let parent_sid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let new_sid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        // Inherited entry from parent (carries parent's sessionId)
        let inherited = format!(
            r#"{{"type":"user","timestamp":1.0,"sessionId":"{parent_sid}","message":{{"role":"user","content":"original"}}}}"#
        );
        // Branch marker — customTitle ends with "(Branch)"
        let marker = format!(
            r#"{{"type":"custom-title","timestamp":2.0,"customTitle":"original prompt text (Branch)","sessionId":"{new_sid}"}}"#
        );
        // New entry written under the new session
        let new_entry = format!(
            r#"{{"type":"user","timestamp":3.0,"sessionId":"{new_sid}","message":{{"role":"user","content":"continue"}}}}"#
        );
        let lines = format!("{inherited}\n{marker}\n{new_entry}");

        let dir = std::env::temp_dir().join(format!("cue_branch_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{}.jsonl", new_sid));
        std::fs::write(&path, lines).unwrap();

        let m = parse_jsonl_to_session_metrics(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(m.branched_from_session_id.as_deref(), Some(parent_sid));
        assert!(
            m.custom_title.is_none(),
            "custom_title should be cleared on branched sessions"
        );
    }

    /// Non-branched custom titles (deliberate `/title` calls) must remain
    /// untouched — the "(Branch)" check should not match plain user titles.
    #[test]
    fn test_non_branched_custom_title_preserved() {
        let sid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
        let lines = format!(
            r#"{{"type":"custom-title","timestamp":1.0,"customTitle":"my-feature","sessionId":"{}"}}"#,
            sid
        );

        let dir = std::env::temp_dir().join(format!("cue_branch_neg_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{}.jsonl", sid));
        std::fs::write(&path, lines).unwrap();

        let m = parse_jsonl_to_session_metrics(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(m.branched_from_session_id.is_none());
        assert_eq!(m.custom_title.as_deref(), Some("my-feature"));
    }

    #[test]
    fn test_three_timestamp_formats() {
        // Unix float
        let e1 = parse_jsonl_content(r#"{"type":"user","timestamp":1710000000.5}"#);
        assert!((e1[0].timestamp.unwrap() - 1710000000.5).abs() < 0.001);

        // ISO string in timestamp field
        let e2 = parse_jsonl_content(r#"{"type":"user","timestamp":"2024-03-10T12:00:00+00:00"}"#);
        assert!(e2[0].timestamp.is_some());

        // isoTimestamp field
        let e3 = parse_jsonl_content(r#"{"type":"user","isoTimestamp":"2024-03-10T12:00:00Z"}"#);
        assert!(e3[0].timestamp.is_some());
    }

    #[test]
    fn test_running_tool_extraction() {
        let line = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/Users/dev/src/main.rs"}}],"stop_reason":"tool_use"}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].has_pending_tool_use);
        assert_eq!(entries[0].running_tool_name.as_deref(), Some("Read"));
        assert_eq!(
            entries[0].running_tool_target.as_deref(),
            Some("src/main.rs")
        );
    }

    #[test]
    fn test_running_tool_bash_target() {
        let line = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50},"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm run build"}}],"stop_reason":"tool_use"}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries[0].running_tool_name.as_deref(), Some("Bash"));
        assert_eq!(
            entries[0].running_tool_target.as_deref(),
            Some("npm run build")
        );
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

    // ── stop_reason=end_turn detection ────────────────────────────────
    // Powers the session_monitor turn-ended recovery path: Claude's own
    // "I'm done" signal, used to demote stuck working/thinking cards when
    // the Stop hook failed to fire. Deterministic — no time thresholds.

    #[test]
    fn test_parse_entry_has_end_turn() {
        let line = r#"{"type":"assistant","timestamp":1710000000.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].has_end_turn);
        assert!(!entries[0].has_pending_tool_use);
    }

    #[test]
    fn test_parse_entry_captures_api_error_text() {
        // An isApiErrorMessage entry yields the human-readable failure reason.
        let line = r#"{"type":"assistant","timestamp":1710000000.0,"isApiErrorMessage":true,"message":{"role":"assistant","stop_reason":"stop_sequence","content":[{"type":"text","text":"There's an issue with the selected model (claude-fable-5)."}]}}"#;
        let entries = parse_jsonl_content(line);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].api_error_text.as_deref(),
            Some("There's an issue with the selected model (claude-fable-5).")
        );
        // A normal assistant message must NOT populate api_error_text.
        let normal = r#"{"type":"assistant","timestamp":1.0,"message":{"content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn"}}"#;
        let n = parse_jsonl_content(normal);
        assert!(n[0].api_error_text.is_none());
    }

    #[test]
    fn test_metrics_captures_last_end_turn_ts() {
        // user → assistant(end_turn) → nothing newer. Should populate the ts.
        let user = r#"{"type":"user","timestamp":1.0,"message":{"content":"hi"}}"#;
        let assistant = r#"{"type":"assistant","timestamp":2.5,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}"#;

        let dir = std::env::temp_dir().join("cue_test_end_turn_ts");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, format!("{}\n{}", user, assistant)).unwrap();

        let m = parse_jsonl_to_session_metrics(&path).unwrap();
        assert_eq!(m.last_end_turn_ts, Some(2.5));
        assert!(!m.pending_tool_use);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_metrics_error_message_set_then_cleared_on_recovery() {
        let user = r#"{"type":"user","timestamp":1.0,"message":{"content":"go"}}"#;
        let api_err = r#"{"type":"assistant","timestamp":2.0,"isApiErrorMessage":true,"message":{"role":"assistant","stop_reason":"stop_sequence","content":[{"type":"text","text":"Model unavailable: claude-fable-5"}]}}"#;
        let recovered = r#"{"type":"assistant","timestamp":3.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":5,"output_tokens":2},"content":[{"type":"text","text":"ok now"}],"stop_reason":"end_turn"}}"#;

        let dir = std::env::temp_dir().join("cue_test_err_msg");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Error is the last assistant turn → its reason is surfaced.
        let p1 = dir.join("a.jsonl");
        std::fs::write(&p1, format!("{user}\n{api_err}")).unwrap();
        let m1 = parse_jsonl_to_session_metrics(&p1).unwrap();
        assert_eq!(
            m1.last_error_message.as_deref(),
            Some("Model unavailable: claude-fable-5")
        );

        // A normal assistant turn after the error → cleared (recovered).
        let p2 = dir.join("b.jsonl");
        std::fs::write(&p2, format!("{user}\n{api_err}\n{recovered}")).unwrap();
        let m2 = parse_jsonl_to_session_metrics(&p2).unwrap();
        assert_eq!(m2.last_error_message, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_metrics_pending_tool_use_suppresses_end_turn() {
        // Older end_turn, then a new turn with an unresolved tool_use.
        // The aggregator sets pending_tool_use; last_end_turn_ts must NOT
        // be populated — the card is mid-turn.
        let prior_end = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}"#;
        let new_user = r#"{"type":"user","timestamp":2.0,"message":{"content":"again"}}"#;
        let pending = r#"{"type":"assistant","timestamp":3.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x.rs"}}],"stop_reason":"tool_use"}}"#;

        let dir = std::env::temp_dir().join("cue_test_end_turn_suppressed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, format!("{}\n{}\n{}", prior_end, new_user, pending)).unwrap();

        let m = parse_jsonl_to_session_metrics(&path).unwrap();
        assert!(m.pending_tool_use);
        assert_eq!(m.last_end_turn_ts, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_metrics_user_prompt_after_end_turn_stops_scan() {
        // end_turn happened, then user kicked off a new turn. We only want
        // end_turn signals that are newer than any user prompt — otherwise
        // the next turn hasn't emitted its own end_turn yet and we'd be
        // acting on a stale signal. Scan from end walks past the new user
        // prompt and stops: no end_turn should be reported.
        let prior_end = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}"#;
        let new_user = r#"{"type":"user","timestamp":2.0,"message":{"content":"again"}}"#;

        let dir = std::env::temp_dir().join("cue_test_user_stops_scan");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, format!("{}\n{}", prior_end, new_user)).unwrap();

        let m = parse_jsonl_to_session_metrics(&path).unwrap();
        assert_eq!(m.last_end_turn_ts, None);
        assert!(!m.pending_tool_use);

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

    // ── cap_snippet ────────────────────────────────────────────────────
    // Guards the privacy/size cap on `last_prompt` and `last_assistant_text`
    // added in the security pass. Multi-MB assistant responses must be
    // clipped before they cross the Tauri IPC boundary.

    #[test]
    fn cap_snippet_leaves_short_text_alone() {
        let s = "hello world";
        assert_eq!(super::cap_snippet(s), s);
    }

    #[test]
    fn cap_snippet_truncates_long_text_with_ellipsis() {
        let s: String = std::iter::repeat_n('a', super::SNIPPET_CHAR_CAP + 500).collect();
        let out = super::cap_snippet(&s);
        // SNIPPET_CHAR_CAP ASCII chars + a single '…' on the end.
        assert_eq!(out.chars().count(), super::SNIPPET_CHAR_CAP + 1);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn cap_snippet_respects_utf8_boundaries() {
        // Multi-byte chars: each '🌊' is 4 bytes, and we want to make sure
        // truncation counts code points (not bytes) so the result never
        // splits a code point.
        let s: String = std::iter::repeat_n('🌊', super::SNIPPET_CHAR_CAP + 10).collect();
        let out = super::cap_snippet(&s);
        // Valid UTF-8 (String::from_utf8 would have panicked on a bad split).
        assert!(out.is_char_boundary(out.len()));
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), super::SNIPPET_CHAR_CAP + 1);
    }

    #[test]
    fn cap_snippet_exact_cap_no_ellipsis() {
        let s: String = std::iter::repeat_n('x', super::SNIPPET_CHAR_CAP).collect();
        let out = super::cap_snippet(&s);
        assert_eq!(out, s);
        assert!(!out.ends_with('…'));
    }

    #[test]
    fn cap_snippet_empty_is_empty() {
        assert_eq!(super::cap_snippet(""), "");
    }

    #[test]
    fn entry_cache_tails_appended_lines() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("cue-jsonl-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jsonl");
        let _ = std::fs::remove_file(&path);

        let line_a = r#"{"type":"user","timestamp":1710000000.0,"message":{"content":"first"}}"#;
        let line_b = r#"{"type":"user","timestamp":1710000001.0,"message":{"content":"second"}}"#;

        std::fs::write(&path, format!("{line_a}\n")).unwrap();

        let mut cache = super::JsonlEntryCache::default();
        super::refresh_entry_cache(&path, &mut cache, true);
        assert_eq!(cache.entries.len(), 1);
        let size_after_first = cache.file_size;
        assert!(size_after_first > 0);

        // Append a second line — only it should be parsed.
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(f, "{line_b}").unwrap();
        drop(f);

        super::refresh_entry_cache(&path, &mut cache, true);
        assert_eq!(cache.entries.len(), 2);
        assert!(cache.file_size > size_after_first);

        // No-change refresh leaves entries alone.
        let entries_before = cache.entries.len();
        super::refresh_entry_cache(&path, &mut cache, true);
        assert_eq!(cache.entries.len(), entries_before);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn entry_cache_resets_on_truncation() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("cue-jsonl-trunc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jsonl");
        let _ = std::fs::remove_file(&path);

        let long_line = r#"{"type":"user","timestamp":1710000000.0,"message":{"content":"first"}}"#;
        std::fs::write(&path, format!("{long_line}\n{long_line}\n")).unwrap();

        let mut cache = super::JsonlEntryCache::default();
        super::refresh_entry_cache(&path, &mut cache, true);
        assert_eq!(cache.entries.len(), 2);

        // Truncate file to a single line — cache should reset and re-parse.
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        writeln!(f, "{long_line}").unwrap();
        drop(f);

        super::refresh_entry_cache(&path, &mut cache, true);
        assert_eq!(cache.entries.len(), 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn entry_cache_holds_partial_trailing_line() {
        let dir = std::env::temp_dir().join(format!("cue-jsonl-partial-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jsonl");
        let _ = std::fs::remove_file(&path);

        let complete = r#"{"type":"user","timestamp":1710000000.0,"message":{"content":"a"}}"#;
        let partial = r#"{"type":"user","timestamp":1710000001.0,"messa"#;
        std::fs::write(&path, format!("{complete}\n{partial}")).unwrap();

        let mut cache = super::JsonlEntryCache::default();
        super::refresh_entry_cache(&path, &mut cache, true);
        // Only the complete line should be parsed; the partial waits.
        assert_eq!(cache.entries.len(), 1);

        // Finish the partial line + add another. Cache should pick both up.
        let rest = r#"ge":{"content":"b"}}"#;
        let third = r#"{"type":"user","timestamp":1710000002.0,"message":{"content":"c"}}"#;
        std::fs::write(&path, format!("{complete}\n{partial}{rest}\n{third}\n")).unwrap();

        super::refresh_entry_cache(&path, &mut cache, true);
        assert_eq!(cache.entries.len(), 3);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn entry_cache_clears_when_file_disappears() {
        let dir = std::env::temp_dir().join(format!("cue-jsonl-gone-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.jsonl");
        let _ = std::fs::remove_file(&path);

        let line = r#"{"type":"user","timestamp":1710000000.0,"message":{"content":"first"}}"#;
        std::fs::write(&path, format!("{line}\n")).unwrap();

        let mut cache = super::JsonlEntryCache::default();
        super::refresh_entry_cache(&path, &mut cache, true);
        assert_eq!(cache.entries.len(), 1);

        std::fs::remove_file(&path).unwrap();
        super::refresh_entry_cache(&path, &mut cache, true);
        assert_eq!(
            cache.entries.len(),
            0,
            "missing file must drop cached entries"
        );
        assert_eq!(cache.file_size, 0);
    }

    #[cfg(unix)]
    #[test]
    fn entry_cache_refuses_to_follow_symlink() {
        use std::os::unix::fs::symlink;
        let dir = std::env::temp_dir().join(format!("cue-jsonl-symlink-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.jsonl");
        let link = dir.join("link.jsonl");
        let _ = std::fs::remove_file(&real);
        let _ = std::fs::remove_file(&link);

        let line = r#"{"type":"user","timestamp":1710000000.0,"message":{"content":"first"}}"#;
        std::fs::write(&real, format!("{line}\n")).unwrap();
        symlink(&real, &link).unwrap();

        // Confirm the symlink is what std::fs::metadata follows…
        assert!(std::fs::metadata(&link).is_ok());

        let mut cache = super::JsonlEntryCache::default();
        super::refresh_entry_cache(&link, &mut cache, true);
        // …but our reader refuses to open through it, so no entries land.
        assert_eq!(
            cache.entries.len(),
            0,
            "O_NOFOLLOW must reject symlinked target"
        );

        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_file(&real);
    }

    // ── Subagent incremental cache (F-perf: don't re-read every tick) ──
    // The main transcript already tailed incrementally; subagents did not, so
    // every active session re-read + re-parsed every agent JSONL in full each
    // 5s tick. These cover the cache's correctness guarantees: hit on an
    // unchanged file, re-parse on growth, invalidation on truncation and
    // mtime-regression, and eviction of caches for deleted agents.

    /// Minimal finished-agent transcript line (tail end_turn ⇒ inactive).
    fn agent_line(id: &str, in_tok: i64, out_tok: i64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":1.0,"agentId":"{id}","message":{{"model":"m","usage":{{"input_tokens":{in_tok},"output_tokens":{out_tok}}},"content":[{{"type":"text","text":"done"}}],"stop_reason":"end_turn"}}}}"#
        )
    }

    #[test]
    fn subagent_cache_hits_on_unchanged_file() {
        let dir = std::env::temp_dir().join(format!("cue-sub-hit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.jsonl");
        std::fs::write(&path, format!("{}\n", agent_line("a1", 10, 5))).unwrap();

        let mut cache = super::JsonlEntryCache::default();
        let m1 = super::parse_subagent_jsonl_cached(&path, &mut cache).unwrap();
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(m1.input_tokens, 10);
        assert_eq!(m1.output_tokens, 5);
        let size_after_first = cache.file_size;
        assert!(size_after_first > 0);

        // Unchanged file: the second parse must reuse the cached entries — the
        // offset doesn't advance and the metrics are identical.
        let m2 = super::parse_subagent_jsonl_cached(&path, &mut cache).unwrap();
        assert_eq!(
            cache.file_size, size_after_first,
            "unchanged file must not re-read"
        );
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(m2.input_tokens, m1.input_tokens);
        assert_eq!(m2.output_tokens, m1.output_tokens);
        assert_eq!(m2.message_count, m1.message_count);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subagent_cache_reparses_on_grow() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("cue-sub-grow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.jsonl");
        std::fs::write(&path, format!("{}\n", agent_line("a1", 10, 5))).unwrap();

        let mut cache = super::JsonlEntryCache::default();
        let m1 = super::parse_subagent_jsonl_cached(&path, &mut cache).unwrap();
        assert_eq!(m1.message_count, 1);
        let size_after_first = cache.file_size;

        // Append a second assistant turn — only the new line should be parsed,
        // and its tokens must roll into the aggregate.
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(f, "{}", agent_line("a1", 100, 50)).unwrap();
        drop(f);

        let m2 = super::parse_subagent_jsonl_cached(&path, &mut cache).unwrap();
        assert_eq!(cache.entries.len(), 2);
        assert!(cache.file_size > size_after_first);
        assert_eq!(m2.message_count, 2);
        assert_eq!(m2.input_tokens, 110);
        assert_eq!(m2.output_tokens, 55);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subagent_cache_invalidates_on_truncation() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("cue-sub-trunc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.jsonl");
        std::fs::write(
            &path,
            format!("{}\n{}\n", agent_line("a1", 10, 5), agent_line("a1", 20, 7)),
        )
        .unwrap();

        let mut cache = super::JsonlEntryCache::default();
        let m1 = super::parse_subagent_jsonl_cached(&path, &mut cache).unwrap();
        assert_eq!(cache.entries.len(), 2);
        assert_eq!(m1.input_tokens, 30);

        // Rewrite shorter (file shrank) — the cache must reset and re-read
        // rather than serve the stale two-entry aggregate.
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        writeln!(f, "{}", agent_line("a1", 3, 1)).unwrap();
        drop(f);

        let m2 = super::parse_subagent_jsonl_cached(&path, &mut cache).unwrap();
        assert_eq!(
            cache.entries.len(),
            1,
            "truncation must invalidate the cache"
        );
        assert_eq!(m2.input_tokens, 3);
        assert_eq!(m2.output_tokens, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subagent_cache_invalidates_on_mtime_regression() {
        // A replaced/forked subagent file can keep the same byte length while
        // its mtime moves backwards. The cache stamps `file_mtime` from the
        // stat it reflects; a stored mtime NEWER than the file on disk means
        // the file was swapped underneath us, so the cache must drop its
        // entries and re-read rather than trust the stale accumulation.
        let dir = std::env::temp_dir().join(format!("cue-sub-mtime-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.jsonl");
        std::fs::write(&path, format!("{}\n", agent_line("a1", 10, 5))).unwrap();

        let mut cache = super::JsonlEntryCache::default();
        super::parse_subagent_jsonl_cached(&path, &mut cache).unwrap();
        assert_eq!(cache.entries.len(), 1);

        // Poison the cache: pretend it reflects a FUTURE mtime and holds a
        // sentinel entry the real file never had. A correct invalidation drops
        // both when it sees the on-disk mtime is older.
        cache.file_mtime =
            Some(std::time::SystemTime::now() + std::time::Duration::from_secs(3600));
        cache.entries.push(super::ParsedEntry {
            entry_type: "SENTINEL".to_string(),
            ..Default::default()
        });

        super::parse_subagent_jsonl_cached(&path, &mut cache).unwrap();
        assert_eq!(
            cache.entries.len(),
            1,
            "mtime regression must reset the cache and re-read from scratch"
        );
        assert!(
            !cache.entries.iter().any(|e| e.entry_type == "SENTINEL"),
            "stale sentinel entry must not survive an mtime-regression reset"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subagent_caches_evict_deleted_agents() {
        // The cached session parse holds a nested cache per subagent file. When
        // an agent's transcript is removed, its cache entry must be pruned so
        // the map is bounded by the live agent count, not the session history.
        let dir = std::env::temp_dir().join(format!("cue-sub-evict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Main transcript: <dir>/<sid>.jsonl ; subagents: <dir>/<sid>/subagents/
        let sid = "11111111-1111-1111-1111-111111111111";
        let main_path = dir.join(format!("{sid}.jsonl"));
        std::fs::write(
            &main_path,
            concat!(
                r#"{"type":"user","timestamp":1.0,"message":{"role":"user","content":"go"}}"#,
                "\n",
                r#"{"type":"assistant","timestamp":2.0,"message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}}"#,
                "\n",
            ),
        )
        .unwrap();

        let subagents_dir = dir.join(sid).join("subagents");
        std::fs::create_dir_all(&subagents_dir).unwrap();
        let agent_a = subagents_dir.join("agent-a.jsonl");
        let agent_b = subagents_dir.join("agent-b.jsonl");
        std::fs::write(&agent_a, format!("{}\n", agent_line("a", 10, 5))).unwrap();
        std::fs::write(&agent_b, format!("{}\n", agent_line("b", 20, 7))).unwrap();

        let mut cache = super::JsonlEntryCache::default();
        let m1 = super::parse_jsonl_to_session_metrics_cached(&main_path, &mut cache).unwrap();
        assert_eq!(m1.subagents.len(), 2);
        assert_eq!(cache.subagent_caches.len(), 2, "both agents cached");

        // Delete one agent transcript, re-parse: its cache entry is evicted.
        std::fs::remove_file(&agent_b).unwrap();
        let m2 = super::parse_jsonl_to_session_metrics_cached(&main_path, &mut cache).unwrap();
        assert_eq!(m2.subagents.len(), 1);
        assert_eq!(
            cache.subagent_caches.len(),
            1,
            "deleted agent's cache entry must be pruned"
        );
        assert!(cache.subagent_caches.contains_key(&agent_a));
        assert!(!cache.subagent_caches.contains_key(&agent_b));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Hostile-input hardening (F-tests-009) ──────────────────────────
    // The parser sits on the untrusted-input boundary: any malformed JSONL
    // line that crashes it empties SessionMetrics and lets the downstream
    // turn-ended / stale-subagent demoters miss their `Some(metrics)` gate.

    #[test]
    fn parse_loads_malformed_fixture_skips_bad_keeps_good() {
        // The fixtures/malformed.jsonl file contains two valid lines and
        // two malformed lines. parse must skip the bad ones without
        // returning an error or losing the good entries.
        let fixture =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/malformed.jsonl");
        let entries = super::parse_jsonl_file(&fixture);
        assert_eq!(entries.len(), 2, "expected 2 valid entries from fixture");
    }

    #[test]
    fn parse_handles_embedded_null_byte() {
        // A line containing a NUL inside the JSON value must not crash
        // the parser; the line should either parse (NUL is valid in a
        // JSON string) or be skipped. Either way, surrounding lines
        // must parse normally.
        let pre = r#"{"type":"user","timestamp":1.0,"message":{"content":"a"}}"#;
        let mid = "{\"type\":\"user\",\"timestamp\":2.0,\"message\":{\"content\":\"a\0b\"}}";
        let post = r#"{"type":"user","timestamp":3.0,"message":{"content":"c"}}"#;
        let content = format!("{}\n{}\n{}", pre, mid, post);
        let entries = super::parse_jsonl_content(&content);
        // At minimum the two unambiguously-valid lines must come through.
        assert!(entries.len() >= 2, "got {} entries", entries.len());
    }

    #[test]
    fn parse_handles_wrong_shape_json() {
        // Valid JSON, wrong shape (missing `type`, unrelated fields).
        // Parser must skip the unusable line rather than panic, and
        // continue parsing surrounding valid lines.
        let pre = r#"{"type":"user","timestamp":1.0,"message":{"content":"hi"}}"#;
        let wrong = r#"{"unrelated":"field","number":42}"#;
        let post = r#"{"type":"user","timestamp":3.0,"message":{"content":"bye"}}"#;
        let content = format!("{}\n{}\n{}", pre, wrong, post);
        let entries = super::parse_jsonl_content(&content);
        // The two real user messages survive. Whether the wrong-shape
        // line is included as a typeless entry or skipped is parser
        // policy; we don't pin it — we only guarantee no panic and the
        // valid entries arrive.
        let user_count = entries.iter().filter(|e| e.entry_type == "user").count();
        assert_eq!(user_count, 2, "expected 2 user entries");
    }

    #[test]
    fn parse_handles_leading_malformed_line() {
        // A failure on line 1 must not abort the whole scan.
        let content = "this is not json at all\n{\"type\":\"user\",\"timestamp\":1.0,\"message\":{\"content\":\"ok\"}}";
        let entries = super::parse_jsonl_content(content);
        assert_eq!(entries.len(), 1, "expected 1 valid entry");
        assert_eq!(entries[0].entry_type, "user");
    }

    #[test]
    fn parse_handles_oversized_single_line() {
        // A pathologically large but still well-formed JSON line should
        // parse without panic. Memory pressure is acceptable; a crash
        // would kill the poll thread.
        let big_text: String = "x".repeat(64 * 1024); // 64 KiB
        let line = format!(
            r#"{{"type":"user","timestamp":1.0,"message":{{"content":"{}"}}}}"#,
            big_text
        );
        let entries = super::parse_jsonl_content(&line);
        assert_eq!(entries.len(), 1);
    }

    // ── Per-entry pending_tool_use contract (F-tests-010) ──────────────
    // The aggregator-level test `test_metrics_pending_tool_use_suppresses_end_turn`
    // verifies the END state, but the foundation invariant is per-entry:
    // an assistant entry with stop_reason == "tool_use" must set
    // has_pending_tool_use=true AND has_end_turn=false. If a refactor
    // flipped has_end_turn to true on pending entries, today's aggregator
    // test still passes (the pending short-circuit hides the stale ts),
    // but once the pending tool_use resolves the stale ts becomes load-
    // bearing and `should_demote_turn_ended` fires on a working session.

    #[test]
    fn test_pending_tool_use_entry_does_not_flag_end_turn() {
        let pending = r#"{"type":"assistant","timestamp":3.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x.rs"}}],"stop_reason":"tool_use"}}"#;
        let entries = super::parse_jsonl_content(pending);
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert!(
            entry.has_pending_tool_use,
            "stop_reason=tool_use must set has_pending_tool_use"
        );
        assert!(
            !entry.has_end_turn,
            "stop_reason=tool_use must NOT set has_end_turn"
        );
    }

    // ── awaiting_user_prompt detection ───────────────────────────────────
    // This is the authoritative signal for state="waiting". Permission
    // prompts and idle notifications are intentionally excluded — only
    // tool calls that genuinely block the assistant on user input qualify.

    #[test]
    fn test_awaiting_user_prompt_when_ask_user_question_unmatched() {
        let user = r#"{"type":"user","timestamp":1.0,"message":{"content":"plan it"}}"#;
        let ask = r#"{"type":"assistant","timestamp":2.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_ask_1","name":"AskUserQuestion","input":{}}],"stop_reason":"tool_use"}}"#;

        let dir = std::env::temp_dir().join("cue_test_await_unmatched");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, format!("{}\n{}", user, ask)).unwrap();

        let m = super::parse_jsonl_to_session_metrics(&path).unwrap();
        assert!(
            m.awaiting_user_prompt,
            "AskUserQuestion without matching tool_result must mark awaiting"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_awaiting_user_prompt_false_when_answered() {
        let ask = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_ask_2","name":"AskUserQuestion","input":{}}],"stop_reason":"tool_use"}}"#;
        let result = r#"{"type":"user","timestamp":2.0,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_ask_2","content":"user picked option A"}]}}"#;

        let dir = std::env::temp_dir().join("cue_test_await_answered");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, format!("{}\n{}", ask, result)).unwrap();

        let m = super::parse_jsonl_to_session_metrics(&path).unwrap();
        assert!(
            !m.awaiting_user_prompt,
            "matching tool_result must clear awaiting"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_interrupt_marker_not_a_prompt_and_sets_ts() {
        // ESC writes a user entry with the marker text. It must not count as
        // a user message (would reset the end_turn scan boundary), must not
        // become the last-prompt pill, and must set last_interrupt_ts.
        let prompt = r#"{"type":"user","timestamp":10.0,"message":{"content":"write a story"}}"#;
        let aborted = r#"{"type":"assistant","timestamp":15.0,"message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"Once upon"}],"stop_reason":"stop_sequence"}}"#;
        let marker = r#"{"type":"user","timestamp":15.1,"message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#;

        let dir = std::env::temp_dir().join("cue_test_interrupt_marker");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, format!("{}\n{}\n{}", prompt, aborted, marker)).unwrap();

        let m = super::parse_jsonl_to_session_metrics(&path).unwrap();
        assert_eq!(m.last_interrupt_ts, Some(15.1));
        assert_eq!(m.user_message_count, 1, "marker must not count as a prompt");
        assert_eq!(m.last_prompt.as_deref(), Some("write a story"));
        assert_eq!(m.last_user_prompt_ts, Some(10.0));
        assert_eq!(
            m.last_end_turn_ts, None,
            "scan must stop at the real prompt, not resurrect a prior end_turn"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_interrupt_marker_tool_use_variant() {
        // String-content form + "for tool use" suffix (tool interrupt).
        let marker = r#"{"type":"user","timestamp":9.0,"message":{"content":"[Request interrupted by user for tool use]"}}"#;

        let dir = std::env::temp_dir().join("cue_test_interrupt_tool");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, marker).unwrap();

        let m = super::parse_jsonl_to_session_metrics(&path).unwrap();
        assert_eq!(m.last_interrupt_ts, Some(9.0));
        assert_eq!(m.user_message_count, 0);
        assert!(m.last_prompt.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_pending_agent_tool_count_tracks_unmatched_agents() {
        // 3-way parallel batch, one agent already returned its tool_result →
        // 2 agents still in flight. The stop_reason-based pending_tool_use
        // would read false here (tool_result at the tail), which is exactly
        // why the count uses unmatched ids instead.
        let batch = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"toolu_a1","name":"Agent","input":{}},{"type":"tool_use","id":"toolu_a2","name":"Agent","input":{}},{"type":"tool_use","id":"toolu_a3","name":"Agent","input":{}}],"stop_reason":"tool_use"}}"#;
        let result1 = r#"{"type":"user","timestamp":2.0,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_a2","content":"done"}]}}"#;

        let dir = std::env::temp_dir().join("cue_test_agent_pending");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, format!("{}\n{}", batch, result1)).unwrap();

        let m = super::parse_jsonl_to_session_metrics(&path).unwrap();
        assert_eq!(m.pending_agent_tool_count, 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_pending_agent_tool_count_zero_when_all_resolved() {
        let batch = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"toolu_b1","name":"Task","input":{}}],"stop_reason":"tool_use"}}"#;
        let result = r#"{"type":"user","timestamp":2.0,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_b1","content":"done"}]}}"#;

        let dir = std::env::temp_dir().join("cue_test_agent_resolved");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, format!("{}\n{}", batch, result)).unwrap();

        let m = super::parse_jsonl_to_session_metrics(&path).unwrap();
        assert_eq!(m.pending_agent_tool_count, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_subagent_is_active_by_tail_state_not_mtime() {
        // Both files have fresh mtimes (just written). The finished agent
        // (tail end_turn) must read inactive immediately; the mid-turn agent
        // (tail tool_use) must read active even though it would also pass a
        // recency check — tail-state decides, mtime is only a crash backstop.
        let dir = std::env::temp_dir().join("cue_test_subagent_tail");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let finished = dir.join("agent-finished.jsonl");
        std::fs::write(&finished, concat!(
            r#"{"type":"assistant","timestamp":1.0,"agentId":"a-fin","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}],"stop_reason":"tool_use"}}"#, "\n",
            r#"{"type":"user","timestamp":2.0,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#, "\n",
            r#"{"type":"assistant","timestamp":3.0,"agentId":"a-fin","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}"#, "\n",
        )).unwrap();
        let m_fin = super::parse_subagent_jsonl(&finished).unwrap();
        assert!(
            !m_fin.is_active,
            "tail end_turn ⇒ finished, despite fresh mtime"
        );

        let running = dir.join("agent-running.jsonl");
        std::fs::write(&running, concat!(
            r#"{"type":"assistant","timestamp":1.0,"agentId":"a-run","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{}}],"stop_reason":"tool_use"}}"#, "\n",
        )).unwrap();
        let m_run = super::parse_subagent_jsonl(&running).unwrap();
        assert!(m_run.is_active, "tail tool_use ⇒ still running");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_subagent_surfaces_running_tool_and_last_text() {
        // The per-subagent quick-report fields mirror the main-session parse:
        // an active agent (tail = pending tool_use) exposes running_tool_name /
        // running_tool_target and its latest assistant prose; a finished agent
        // (tail = end_turn text) has no running tool but keeps its final text
        // as the result.
        let dir = std::env::temp_dir().join("cue_test_subagent_activity");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let running = dir.join("agent-activity-running.jsonl");
        std::fs::write(&running, concat!(
            r#"{"type":"assistant","timestamp":1.0,"agentId":"a-act","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"Scanning the codebase"}],"stop_reason":"end_turn"}}"#, "\n",
            r#"{"type":"assistant","timestamp":2.0,"agentId":"a-act","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"ra1","name":"Read","input":{"file_path":"src/audit.rs"}}],"stop_reason":"tool_use"}}"#, "\n",
        )).unwrap();
        let m_run = super::parse_subagent_jsonl(&running).unwrap();
        assert!(m_run.is_active, "tail tool_use ⇒ still running");
        assert_eq!(m_run.running_tool_name.as_deref(), Some("Read"));
        assert_eq!(
            m_run.running_tool_target.as_deref(),
            Some("src/audit.rs"),
            "running tool target is the pending tool_use input"
        );
        assert_eq!(
            m_run.last_assistant_text.as_deref(),
            Some("Scanning the codebase"),
            "latest non-empty assistant text is surfaced"
        );

        let finished = dir.join("agent-activity-finished.jsonl");
        std::fs::write(&finished, concat!(
            r#"{"type":"assistant","timestamp":1.0,"agentId":"a-done","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"rb1","name":"Bash","input":{}}],"stop_reason":"tool_use"}}"#, "\n",
            r#"{"type":"user","timestamp":2.0,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"rb1","content":"ok"}]}}"#, "\n",
            r#"{"type":"assistant","timestamp":3.0,"agentId":"a-done","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"Audit complete: no issues found"}],"stop_reason":"end_turn"}}"#, "\n",
        )).unwrap();
        let m_fin = super::parse_subagent_jsonl(&finished).unwrap();
        assert!(!m_fin.is_active, "tail end_turn ⇒ finished");
        assert!(
            m_fin.running_tool_name.is_none(),
            "a resolved tool_result clears the running tool"
        );
        assert_eq!(
            m_fin.last_assistant_text.as_deref(),
            Some("Audit complete: no issues found"),
            "finished agent keeps its final text as the result"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_subagent_jsonl_parsed_when_all_rows_sidechain() {
        // Real background-`Agent` transcripts (subagents/agent-*.jsonl) write
        // EVERY row as `isSidechain: true`. The main-transcript parse drops
        // those rows; if parse_subagent_jsonl reused that filter the file would
        // parse to zero entries → None → the agent never reaches m.subagents →
        // the parent card shows idle for the whole background batch. Keeping
        // sidechain rows here is the fix.
        let dir = std::env::temp_dir().join("cue_test_subagent_sidechain");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let running = dir.join("agent-sidechain-running.jsonl");
        std::fs::write(&running, concat!(
            r#"{"type":"user","isSidechain":true,"timestamp":1.0,"agentId":"a-sc","message":{"role":"user","content":[{"type":"text","text":"audit this"}]}}"#, "\n",
            r#"{"type":"assistant","isSidechain":true,"timestamp":2.0,"agentId":"a-sc","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"sc1","name":"Read","input":{}}],"stop_reason":"tool_use"}}"#, "\n",
        )).unwrap();
        let m_run = super::parse_subagent_jsonl(&running)
            .expect("all-sidechain agent file must still parse (was None before fix)");
        assert!(m_run.is_active, "tail tool_use ⇒ still running");
        assert_eq!(m_run.agent_id, "a-sc");

        let finished = dir.join("agent-sidechain-finished.jsonl");
        std::fs::write(&finished, concat!(
            r#"{"type":"user","isSidechain":true,"timestamp":1.0,"agentId":"a-sc2","message":{"role":"user","content":[{"type":"text","text":"audit this"}]}}"#, "\n",
            r#"{"type":"assistant","isSidechain":true,"timestamp":2.0,"agentId":"a-sc2","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}"#, "\n",
        )).unwrap();
        let m_fin = super::parse_subagent_jsonl(&finished)
            .expect("all-sidechain agent file must still parse");
        assert!(!m_fin.is_active, "tail end_turn ⇒ finished");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_subagent_cached_path_keeps_sidechain_rows() {
        // Regression for the hot-path landmine: the production 5s metrics tick
        // reaches a subagent transcript through
        // parse_subagent_jsonl_cached → refresh_entry_cache — NOT the one-shot
        // parse_subagent_jsonl that test_subagent_jsonl_parsed_when_all_rows_sidechain
        // covers. That cached path used to call the sidechain-DROPPING parse_line,
        // so an all-`isSidechain:true` subagent file (which every real
        // background-Agent transcript is) tailed to zero cached entries → None →
        // the agent never reached m.subagents and the parent card sat on idle for
        // the whole run. refresh_entry_cache(.., drop_sidechain=false) on the
        // subagent path is the fix. Neither branch's tests exercised this path.
        use std::io::Write;
        let dir =
            std::env::temp_dir().join(format!("cue-sub-cached-sidechain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent-sidechain-cached.jsonl");
        std::fs::write(&path, concat!(
            r#"{"type":"user","isSidechain":true,"timestamp":1.0,"agentId":"a-cached","message":{"role":"user","content":[{"type":"text","text":"audit this"}]}}"#, "\n",
            r#"{"type":"assistant","isSidechain":true,"timestamp":2.0,"agentId":"a-cached","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"c1","name":"Read","input":{}}],"stop_reason":"tool_use"}}"#, "\n",
        )).unwrap();

        let mut cache = super::JsonlEntryCache::default();
        let m = super::parse_subagent_jsonl_cached(&path, &mut cache).expect(
            "cached path must parse an all-sidechain subagent file (was None before the fix)",
        );
        assert!(
            !cache.entries.is_empty(),
            "refresh_entry_cache must KEEP sidechain rows on the subagent cached path"
        );
        assert_eq!(m.agent_id, "a-cached");
        assert!(m.is_active, "tail tool_use ⇒ agent still running");

        // The incremental tail read must keep sidechain rows too: append a
        // finishing end_turn row and confirm the cache tails it in (not dropped).
        let finish_row = r#"{"type":"assistant","isSidechain":true,"timestamp":3.0,"agentId":"a-cached","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}"#;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(f, "{finish_row}").unwrap();
        drop(f);
        let m2 = super::parse_subagent_jsonl_cached(&path, &mut cache)
            .expect("cached path still parses after tailing more sidechain rows");
        assert_eq!(
            cache.entries.len(),
            3,
            "appended sidechain row must be tailed in, not dropped"
        );
        assert!(!m2.is_active, "tail end_turn ⇒ agent finished");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_main_parse_still_drops_sidechain_rows() {
        // The fix must NOT relax sidechain filtering on the MAIN transcript:
        // an interleaved subagent end_turn must not be counted as the parent's.
        let dir = std::env::temp_dir().join("cue_test_main_drops_sidechain");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("main.jsonl");
        std::fs::write(&path, concat!(
            r#"{"type":"user","timestamp":1.0,"message":{"role":"user","content":[{"type":"text","text":"go"}]}}"#, "\n",
            r#"{"type":"assistant","isSidechain":true,"timestamp":2.0,"message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"subagent reply"}],"stop_reason":"end_turn"}}"#, "\n",
            r#"{"type":"assistant","timestamp":3.0,"message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"m1","name":"Bash","input":{}}],"stop_reason":"tool_use"}}"#, "\n",
        )).unwrap();
        let m = super::parse_jsonl_to_session_metrics(&path).unwrap();
        // The sidechain end_turn must be invisible to the main parse.
        assert_eq!(
            m.last_end_turn_ts, None,
            "sidechain end_turn must not register on the main transcript"
        );
        assert!(
            m.pending_tool_use,
            "main turn's own tool_use should remain pending"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_awaiting_user_prompt_recognizes_exit_plan_mode() {
        let plan = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_plan_1","name":"ExitPlanMode","input":{"plan":"do the thing"}}],"stop_reason":"tool_use"}}"#;

        let dir = std::env::temp_dir().join("cue_test_await_exitplan");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, plan).unwrap();

        let m = super::parse_jsonl_to_session_metrics(&path).unwrap();
        assert!(
            m.awaiting_user_prompt,
            "unmatched ExitPlanMode must mark awaiting"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_awaiting_user_prompt_ignores_non_prompting_tools() {
        // Bash tool_use with no result is NOT awaiting — it's running.
        // Only AskUserQuestion / ExitPlanMode count.
        let bash = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_bash_1","name":"Bash","input":{"command":"ls"}}],"stop_reason":"tool_use"}}"#;

        let dir = std::env::temp_dir().join("cue_test_await_bash");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, bash).unwrap();

        let m = super::parse_jsonl_to_session_metrics(&path).unwrap();
        assert!(
            !m.awaiting_user_prompt,
            "non-prompting tools must not mark awaiting"
        );
        assert!(m.pending_tool_use, "but pending_tool_use should still fire");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_awaiting_user_prompt_handles_multiple_ids() {
        // Two AskUserQuestion calls, one answered, one pending → still awaiting.
        let ask1 = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_q1","name":"AskUserQuestion","input":{}}],"stop_reason":"tool_use"}}"#;
        let result1 = r#"{"type":"user","timestamp":2.0,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_q1","content":"A"}]}}"#;
        let ask2 = r#"{"type":"assistant","timestamp":3.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_q2","name":"AskUserQuestion","input":{}}],"stop_reason":"tool_use"}}"#;

        let dir = std::env::temp_dir().join("cue_test_await_multi");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, format!("{}\n{}\n{}", ask1, result1, ask2)).unwrap();

        let m = super::parse_jsonl_to_session_metrics(&path).unwrap();
        assert!(
            m.awaiting_user_prompt,
            "second pending question keeps awaiting=true"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_sidechain_entries_do_not_corrupt_main_state() {
        // The main turn has FINISHED (end_turn). A Task subagent is still
        // running and — in the interleaved-transcript layout — appends its own
        // entries flagged `isSidechain:true`: a pending Bash tool_use and an
        // unanswered AskUserQuestion. Without source filtering, the backward
        // scan would read the sidechain's pending tool_use as the main card's
        // (false `working`), and the sidechain AskUserQuestion would set
        // `awaiting_user_prompt` (false `waiting`). The filter must scope every
        // verdict to the main conversation: pending=false, awaiting=false, and
        // the main end_turn timestamp preserved.
        let main_end = r#"{"type":"assistant","timestamp":100.0,"isSidechain":false,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}"#;
        let side_tool = r#"{"type":"assistant","timestamp":101.0,"isSidechain":true,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_side_bash","name":"Bash","input":{"command":"ls"}}],"stop_reason":"tool_use"}}"#;
        let side_ask = r#"{"type":"assistant","timestamp":102.0,"isSidechain":true,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_side_q","name":"AskUserQuestion","input":{}}],"stop_reason":"tool_use"}}"#;

        let dir = std::env::temp_dir().join("cue_test_sidechain");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, format!("{}\n{}\n{}", main_end, side_tool, side_ask)).unwrap();

        let m = super::parse_jsonl_to_session_metrics(&path).unwrap();
        assert!(
            !m.pending_tool_use,
            "a subagent's pending tool_use must not flag the main card"
        );
        assert!(
            !m.awaiting_user_prompt,
            "a subagent's AskUserQuestion must not mark the main card waiting"
        );
        assert_eq!(
            m.last_end_turn_ts,
            Some(100.0),
            "main turn's end_turn must remain the ground-truth finish signal"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn write_metrics_transcript(tag: &str, lines: &[&str]) -> crate::models::SessionMetrics {
        let dir = std::env::temp_dir().join(format!("cue_test_{}", tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, lines.join("\n")).unwrap();
        let m = super::parse_jsonl_to_session_metrics(&path).expect("metrics");
        let _ = std::fs::remove_dir_all(&dir);
        m
    }

    // F-tests-002 (resolve half): a permission-prompt `waiting` card demotes the
    // instant the tool is approved and its `tool_result` lands. The backward
    // scan must `break` on the trailing tool_result so the now-resolved tool_use
    // no longer flags `pending_tool_use`. (Flip line ~1096 `if entry.is_tool_result
    // { break }` to `if false { ... }` and this test fails — pending stays true.)
    #[test]
    fn test_pending_tool_use_clears_when_matching_tool_result_lands() {
        let tool_use = r#"{"type":"assistant","timestamp":101.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_a","name":"Bash","input":{"command":"ls"}}],"stop_reason":"tool_use"}}"#;
        let tool_result = r#"{"type":"user","timestamp":102.0,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_a","content":"ok"}]}}"#;
        let m = write_metrics_transcript("pending_clears", &[tool_use, tool_result]);
        assert!(
            !m.pending_tool_use,
            "an approved tool's tool_result at the tail must clear pending_tool_use"
        );
    }

    // F-tests-002 (seed half): an unresolved tool_use at the tail keeps
    // `pending_tool_use` set — this is what holds a permission-prompt card on
    // `waiting` until the user responds. Guards the test above from passing
    // trivially (i.e. proves pending CAN be true for this transcript shape).
    #[test]
    fn test_pending_tool_use_holds_when_tool_use_unresolved() {
        let tool_use = r#"{"type":"assistant","timestamp":101.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_b","name":"Bash","input":{"command":"ls"}}],"stop_reason":"tool_use"}}"#;
        let m = write_metrics_transcript("pending_holds", &[tool_use]);
        assert!(
            m.pending_tool_use,
            "an unresolved trailing tool_use must keep pending_tool_use set"
        );
    }

    // F-protocol-001: the auto `ai-title` entry (what current Claude Code writes
    // for nearly every session) must reach the UI subtitle via `custom_title`.
    #[test]
    fn test_ai_title_used_as_fallback_subtitle() {
        let asst = r#"{"type":"assistant","timestamp":100.0,"message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn"}}"#;
        let ai_title = r#"{"type":"ai-title","timestamp":101.0,"aiTitle":"Review house purchase scenarios","sessionId":"s1"}"#;
        let m = write_metrics_transcript("ai_title", &[asst, ai_title]);
        assert_eq!(
            m.custom_title.as_deref(),
            Some("Review house purchase scenarios"),
            "ai-title must fall back into the subtitle when no explicit title exists"
        );
    }

    // F-protocol-001: an explicit `custom-title` (the user's `/title` or the
    // fork "(Branch)" marker) stays authoritative even when an `ai-title` is
    // written afterward — otherwise "last one wins" would let the auto title
    // clobber a deliberate one and break `(Branch)` fork detection.
    #[test]
    fn test_explicit_custom_title_wins_over_ai_title() {
        let custom = r#"{"type":"custom-title","timestamp":100.0,"customTitle":"My deliberate title","sessionId":"s1"}"#;
        let ai_title = r#"{"type":"ai-title","timestamp":101.0,"aiTitle":"Auto generated title","sessionId":"s1"}"#;
        let m = write_metrics_transcript("title_precedence", &[custom, ai_title]);
        assert_eq!(
            m.custom_title.as_deref(),
            Some("My deliberate title"),
            "explicit custom-title must win over a later ai-title"
        );
    }

    #[test]
    fn test_awaiting_cleared_when_prompt_superseded_by_later_work() {
        // Regression: an AskUserQuestion with NO tool_result (Claude Code doesn't
        // always record one for an answered prompt) followed by more work must NOT
        // keep the session "waiting" — it was answered/abandoned and the session
        // moved on. Previously this pinned a card on "awaiting you" for hours.
        let ask = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_ask_open","name":"AskUserQuestion","input":{}}],"stop_reason":"tool_use"}}"#;
        // …then the assistant went on to run an Edit that returned a tool_result.
        let edit = r#"{"type":"assistant","timestamp":2.0,"message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_edit1","name":"Edit","input":{}}],"stop_reason":"tool_use"}}"#;
        let result = r#"{"type":"user","timestamp":3.0,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_edit1"}]}}"#;
        let m = write_metrics_transcript("await_superseded", &[ask, edit, result]);
        assert!(
            !m.awaiting_user_prompt,
            "an unresolved AskUserQuestion superseded by later work must NOT mark awaiting"
        );
    }

    #[test]
    fn test_awaiting_true_when_open_prompt_is_the_tail() {
        // Guard the other direction: a genuinely-open AskUserQuestion (nothing
        // turn-advancing after it, only metadata rows) still marks awaiting.
        let ask = r#"{"type":"assistant","timestamp":1.0,"message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_ask_tail","name":"AskUserQuestion","input":{}}],"stop_reason":"tool_use"}}"#;
        let meta = r#"{"type":"ai-title","aiTitle":"Some title","sessionId":"s1"}"#;
        let m = write_metrics_transcript("await_tail", &[ask, meta]);
        assert!(
            m.awaiting_user_prompt,
            "an open AskUserQuestion at the tail (only metadata after) must mark awaiting"
        );
    }
}
