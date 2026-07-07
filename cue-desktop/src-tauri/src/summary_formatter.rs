//! Format tool_input into human-readable one-line summaries.
//!
//! Used by the permission prompt UI to show a concise description of what
//! the tool is requesting permission to do.

/// Format a tool use into a human-readable summary string.
pub fn format_tool_summary(tool_name: &str, tool_input: &serde_json::Value) -> String {
    match tool_name {
        "Bash" => {
            let cmd = tool_input
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("(unknown command)");
            let truncated = truncate(cmd, 80);
            format!("Run: `{}`", truncated)
        }
        "Read" => {
            let path = tool_input
                .get("file_path")
                .and_then(|v| v.as_str())
                .unwrap_or("(unknown file)");
            format!("Read: `{}`", path)
        }
        "Edit" => {
            let path = tool_input
                .get("file_path")
                .and_then(|v| v.as_str())
                .unwrap_or("(unknown file)");
            format!("Edit: `{}`", path)
        }
        "Write" => {
            let path = tool_input
                .get("file_path")
                .and_then(|v| v.as_str())
                .unwrap_or("(unknown file)");
            format!("Write: `{}`", path)
        }
        "Glob" => {
            let pattern = tool_input
                .get("pattern")
                .and_then(|v| v.as_str())
                .unwrap_or("(unknown pattern)");
            format!("Search: `{}`", pattern)
        }
        "Grep" => {
            let pattern = tool_input
                .get("pattern")
                .and_then(|v| v.as_str())
                .unwrap_or("(unknown pattern)");
            format!("Search for: `{}`", pattern)
        }
        _ => {
            // Generic: show first key=value
            if let Some(obj) = tool_input.as_object() {
                if let Some((key, val)) = obj.iter().next() {
                    let val_str = match val.as_str() {
                        Some(s) => truncate(s, 60),
                        None => truncate(&val.to_string(), 60),
                    };
                    return format!("`{}`: {}={}", tool_name, key, val_str);
                }
            }
            format!("`{}`", tool_name)
        }
    }
}

/// Truncate a string to `max_len` total characters (including "..." suffix).
pub(crate) fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        let end = max_len.saturating_sub(3);
        // Find a valid UTF-8 char boundary at or before the target index
        let end = s.floor_char_boundary(end);
        format!("{}...", &s[..end])
    }
}

/// Flatten Markdown to plain prose for a one-line notification body: drop
/// bold/italic/strike markers and code backticks, strip leading heading/quote
/// markers, and collapse all whitespace (incl. newlines) to single spaces.
/// Conservative — it won't mangle `snake_case` identifiers (only the doubled
/// `**`/`__` and backticks are removed, not lone `_`/`*`).
pub(crate) fn strip_markdown(s: &str) -> String {
    let flattened = s
        .replace("**", "")
        .replace("__", "")
        .replace("~~", "")
        .replace('`', "");
    let collapsed = flattened.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .trim_start_matches(['#', '>', ' '])
        .trim()
        .to_string()
}

/// The last question in `s` — the trailing sentence ending in `?` — or `None`.
/// "Needs you" bodies want the assistant's actual question, not the opening.
pub(crate) fn last_question(s: &str) -> Option<String> {
    let s = s.trim();
    let qpos = s.rfind('?')?;
    let start = s[..qpos]
        .rfind(['.', '!', '?', '\n'])
        .map(|i| i + 1)
        .unwrap_or(0);
    let q = s[start..=qpos].trim();
    (!q.is_empty()).then(|| q.to_string())
}

/// The last non-empty (trimmed) line of `s` — usually the conclusion of a
/// multi-line message. Used for the "finished" outcome line.
pub(crate) fn last_line(s: &str) -> Option<String> {
    s.lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_bash_summary() {
        let input = json!({"command": "npm install --save-dev typescript"});
        let summary = format_tool_summary("Bash", &input);
        assert_eq!(summary, "Run: `npm install --save-dev typescript`");
    }

    #[test]
    fn test_bash_missing_command() {
        let input = json!({});
        let summary = format_tool_summary("Bash", &input);
        assert_eq!(summary, "Run: `(unknown command)`");
    }

    #[test]
    fn test_read_summary() {
        let input = json!({"file_path": "/src/main.rs"});
        let summary = format_tool_summary("Read", &input);
        assert_eq!(summary, "Read: `/src/main.rs`");
    }

    #[test]
    fn test_edit_summary() {
        let input = json!({"file_path": "/src/lib.rs", "old_string": "foo", "new_string": "bar"});
        let summary = format_tool_summary("Edit", &input);
        assert_eq!(summary, "Edit: `/src/lib.rs`");
    }

    #[test]
    fn test_write_summary() {
        let input = json!({"file_path": "/tmp/output.txt", "content": "hello"});
        let summary = format_tool_summary("Write", &input);
        assert_eq!(summary, "Write: `/tmp/output.txt`");
    }

    #[test]
    fn test_glob_summary() {
        let input = json!({"pattern": "**/*.rs"});
        let summary = format_tool_summary("Glob", &input);
        assert_eq!(summary, "Search: `**/*.rs`");
    }

    #[test]
    fn test_grep_summary() {
        let input = json!({"pattern": "fn main"});
        let summary = format_tool_summary("Grep", &input);
        assert_eq!(summary, "Search for: `fn main`");
    }

    #[test]
    fn test_bash_truncation() {
        let long_cmd = "a".repeat(120);
        let input = json!({"command": long_cmd});
        let summary = format_tool_summary("Bash", &input);
        // Should be "Run: `" + 80 chars + "...`"
        assert!(summary.contains("..."));
        assert!(summary.len() < 100); // much shorter than 120-char original
    }

    #[test]
    fn test_unknown_tool_with_object_input() {
        let input = json!({"url": "https://example.com", "method": "GET"});
        let summary = format_tool_summary("HttpRequest", &input);
        // Should show first key=value
        assert!(summary.starts_with("`HttpRequest`: "));
        assert!(summary.contains("="));
    }

    #[test]
    fn test_unknown_tool_with_empty_input() {
        let input = json!({});
        let summary = format_tool_summary("CustomTool", &input);
        assert_eq!(summary, "`CustomTool`");
    }

    #[test]
    fn test_unknown_tool_with_null_input() {
        let input = json!(null);
        let summary = format_tool_summary("CustomTool", &input);
        assert_eq!(summary, "`CustomTool`");
    }

    #[test]
    fn test_unknown_tool_with_numeric_value() {
        let input = json!({"count": 42});
        let summary = format_tool_summary("Counter", &input);
        assert_eq!(summary, "`Counter`: count=42");
    }

    #[test]
    fn test_truncate_short_string() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_exact_length() {
        assert_eq!(truncate("hello", 5), "hello");
    }

    #[test]
    fn test_truncate_long_string() {
        // max_len=8 means 5 chars + "..." = 8 total
        let result = truncate("hello world", 8);
        assert_eq!(result, "hello...");
    }

    #[test]
    fn test_missing_file_path_keys() {
        let input = json!({"other_key": "value"});

        assert_eq!(
            format_tool_summary("Read", &input),
            "Read: `(unknown file)`"
        );
        assert_eq!(
            format_tool_summary("Edit", &input),
            "Edit: `(unknown file)`"
        );
        assert_eq!(
            format_tool_summary("Write", &input),
            "Write: `(unknown file)`"
        );
    }

    #[test]
    fn test_missing_pattern_keys() {
        let input = json!({"other_key": "value"});

        assert_eq!(
            format_tool_summary("Glob", &input),
            "Search: `(unknown pattern)`"
        );
        assert_eq!(
            format_tool_summary("Grep", &input),
            "Search for: `(unknown pattern)`"
        );
    }

    // --- notification body helpers ----------------------------------------

    #[test]
    fn strip_markdown_removes_bold_code_and_headings() {
        assert_eq!(
            strip_markdown("**Appearance** is exactly where you `set` it."),
            "Appearance is exactly where you set it."
        );
        assert_eq!(strip_markdown("## Done\n- shipped"), "Done - shipped");
        assert_eq!(strip_markdown("> a quote"), "a quote");
    }

    #[test]
    fn strip_markdown_keeps_snake_case_and_lone_punct() {
        // Lone underscores (identifiers) and single asterisks are preserved.
        assert_eq!(
            strip_markdown("ran build_event in 5*x time"),
            "ran build_event in 5*x time"
        );
    }

    #[test]
    fn strip_markdown_collapses_whitespace() {
        assert_eq!(strip_markdown("a\n\n  b   c"), "a b c");
    }

    #[test]
    fn last_question_extracts_trailing_question() {
        let s = "I looked at the schema. There are two paths here. Which migration approach should I take?";
        assert_eq!(
            last_question(s).as_deref(),
            Some("Which migration approach should I take?")
        );
    }

    #[test]
    fn last_question_is_none_without_a_question() {
        assert_eq!(last_question("All done. Pushed the fix."), None);
    }

    #[test]
    fn last_line_returns_the_conclusion() {
        let s = "Working through it.\nRan the suite.\nAll 214 tests green, ready for review.\n";
        assert_eq!(
            last_line(s).as_deref(),
            Some("All 214 tests green, ready for review.")
        );
    }
}
