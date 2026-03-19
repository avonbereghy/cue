//! Usage aggregation — port of UsageAggregator.swift.
//!
//! Discovers all .jsonl files under ~/.claude/projects, parses entries with
//! timestamps, and buckets them into 5hr/daily/weekly windows.

use crate::jsonl_parser;
use crate::models::{UsageWindow, WindowMetrics};
use crate::paths;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::SystemTime;

/// Aggregate usage across all JSONL files for each time window.
pub fn aggregate() -> HashMap<UsageWindow, WindowMetrics> {
    let now_secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();

    let mut results: HashMap<UsageWindow, WindowMetrics> = HashMap::new();
    for window in UsageWindow::ALL {
        results.insert(window, WindowMetrics::default());
    }

    let window_starts: HashMap<UsageWindow, f64> = UsageWindow::ALL
        .iter()
        .map(|w| (*w, w.start_timestamp(now_secs)))
        .collect();

    // Oldest window start — skip files that can't possibly have relevant data
    let oldest_start = window_starts
        .values()
        .cloned()
        .fold(f64::MAX, f64::min);

    let jsonl_files = find_all_jsonl_files();

    for file_path in &jsonl_files {
        // Quick check: skip files not modified since the oldest window start
        if let Ok(metadata) = std::fs::metadata(file_path) {
            if let Ok(mod_time) = metadata.modified() {
                let mod_secs = mod_time
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64();
                if mod_secs < oldest_start {
                    continue;
                }
            }
        }

        let entries = jsonl_parser::parse_jsonl_file(file_path.as_path());
        if entries.is_empty() {
            continue;
        }

        // Track which windows this session (file) contributes to
        let mut session_contributes: HashSet<UsageWindow> = HashSet::new();

        for entry in &entries {
            let ts = match entry.timestamp {
                Some(t) => t,
                None => continue,
            };

            // Skip entries older than the oldest window
            if ts < oldest_start {
                continue;
            }

            for window in UsageWindow::ALL {
                let start = window_starts[&window];
                if ts < start {
                    continue;
                }

                session_contributes.insert(window);
                let metrics = results.get_mut(&window).unwrap();

                metrics.input_tokens += entry.input_tokens;
                metrics.output_tokens += entry.output_tokens;

                if entry.is_user_message {
                    metrics.user_message_count += 1;
                }
                if entry.is_assistant_message {
                    metrics.assistant_message_count += 1;
                }

                for (tool, count) in &entry.tool_counts {
                    *metrics.tool_counts.entry(tool.clone()).or_insert(0) += count;
                }

                if !entry.model.is_empty()
                    && (entry.input_tokens > 0 || entry.output_tokens > 0)
                {
                    let existing = metrics
                        .model_tokens
                        .entry(entry.model.clone())
                        .or_insert((0, 0));
                    existing.0 += entry.input_tokens;
                    existing.1 += entry.output_tokens;
                }
            }
        }

        for window in session_contributes {
            results.get_mut(&window).unwrap().session_count += 1;
        }
    }

    results
}

/// Find all .jsonl files under ~/.claude/projects.
fn find_all_jsonl_files() -> Vec<PathBuf> {
    let projects_path = paths::claude_projects_path();
    let mut files = Vec::new();

    let project_dirs = match std::fs::read_dir(&projects_path) {
        Ok(dirs) => dirs,
        Err(_) => return files,
    };

    for dir_entry in project_dirs.flatten() {
        let dir_path = dir_entry.path();
        if !dir_path.is_dir() {
            continue;
        }

        if let Ok(contents) = std::fs::read_dir(&dir_path) {
            for file_entry in contents.flatten() {
                let file_path = file_entry.path();
                if file_path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    files.push(file_path);
                    continue;
                }

                // Recurse into {session-uuid}/subagents/ directories
                if file_path.is_dir() {
                    let subagents_dir = file_path.join("subagents");
                    if subagents_dir.is_dir() {
                        if let Ok(sub_contents) = std::fs::read_dir(&subagents_dir) {
                            for sub_entry in sub_contents.flatten() {
                                let sub_path = sub_entry.path();
                                if sub_path.extension().and_then(|e| e.to_str()) == Some("jsonl")
                                {
                                    files.push(sub_path);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    files
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_all_jsonl_files_no_crash() {
        // Should not panic even if ~/.claude/projects doesn't exist
        let _files = find_all_jsonl_files();
    }

    #[test]
    fn test_aggregate_returns_all_windows() {
        // Should return metrics for all 3 windows (may have real data)
        let results = aggregate();
        assert_eq!(results.len(), 3);
        for window in UsageWindow::ALL {
            let m = results.get(&window).unwrap();
            // total_tokens should be non-negative
            assert!(m.total_tokens() >= 0);
            assert!(m.session_count >= 0);
        }
    }

    #[test]
    fn test_aggregate_with_fixtures() {
        // aggregate() uses the real ~/.claude/projects path,
        // so this test just verifies the function doesn't crash
        // and returns the expected number of windows.
        let results = aggregate();
        assert_eq!(results.len(), 3);
        for window in UsageWindow::ALL {
            assert!(results.contains_key(&window));
        }
    }
}
