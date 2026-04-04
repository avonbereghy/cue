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
        format!("{}...", &s[..max_len.saturating_sub(3)])
    }
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

        assert_eq!(format_tool_summary("Read", &input), "Read: `(unknown file)`");
        assert_eq!(format_tool_summary("Edit", &input), "Edit: `(unknown file)`");
        assert_eq!(format_tool_summary("Write", &input), "Write: `(unknown file)`");
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
}
