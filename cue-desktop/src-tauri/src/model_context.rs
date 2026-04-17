//! Model → context-window lookup.
//!
//! Claude Code embeds its own model-to-context logic inside the `claude` binary
//! (a Bun-compiled JS bundle). We parse that binary at first lookup, find the
//! OR-chain of `.includes("model-id")` calls that sit near the `1e6` literal
//! (the 1M context window), and extract the model substrings. This mirrors
//! Claude Code's internal `Ko`/`xR` functions and keeps Cue in sync whenever
//! Anthropic ships a new 1M-capable model — no network calls required.
//!
//! Falls back to a baked-in list if the binary can't be found or parsed.
//!
//! Also honors `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (the same env override the
//! CLI respects) and the `[1m]` model-name suffix.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

pub const DEFAULT_CONTEXT_WINDOW: i64 = 200_000;
pub const LARGE_CONTEXT_WINDOW: i64 = 1_000_000;

/// Baked-in fallback. Used when we can't find or parse the `claude` binary.
/// Substring matches against the (lowercased) model id.
const FALLBACK_1M_SUBSTRINGS: &[&str] = &[
    "sonnet-4",
    "opus-4-5",
    "opus-4-6",
    "opus-4-7",
];

static ONE_M_SUBSTRINGS: OnceLock<Vec<String>> = OnceLock::new();

/// Resolve the context window for a given model id.
pub fn context_limit_for(model: &str) -> i64 {
    if let Some(n) = env_override() {
        return n;
    }
    let lower = model.to_lowercase();
    // Claude Code recognises a `[1m]` suffix as a per-session opt-in.
    if lower.contains("[1m]") {
        return LARGE_CONTEXT_WINDOW;
    }
    // Synthetic test sessions are always wide.
    if model == "<synthetic>" {
        return LARGE_CONTEXT_WINDOW;
    }
    let subs = ONE_M_SUBSTRINGS.get_or_init(detect_1m_substrings);
    context_limit_from_subs(&lower, subs)
}

fn context_limit_from_subs(model_lower: &str, subs: &[String]) -> i64 {
    if subs.iter().any(|s| model_lower.contains(s.as_str())) {
        LARGE_CONTEXT_WINDOW
    } else {
        DEFAULT_CONTEXT_WINDOW
    }
}

fn env_override() -> Option<i64> {
    let v = std::env::var("CLAUDE_CODE_MAX_CONTEXT_TOKENS").ok()?;
    v.trim().parse::<i64>().ok().filter(|n| *n > 0)
}

fn detect_1m_substrings() -> Vec<String> {
    match extract_from_claude_binary() {
        Some(v) if !v.is_empty() => {
            log::info!("model_context: extracted 1M model list from claude binary: {:?}", v);
            v
        }
        _ => {
            log::debug!("model_context: falling back to baked-in 1M model list");
            FALLBACK_1M_SUBSTRINGS.iter().map(|s| s.to_string()).collect()
        }
    }
}

fn extract_from_claude_binary() -> Option<Vec<String>> {
    let path = find_claude_binary()?;
    let meta = fs::metadata(&path).ok()?;
    // Guard: don't slurp anything pathologically large.
    if meta.len() == 0 || meta.len() > 512 * 1024 * 1024 {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    let models = scan_for_1m_models(&bytes);
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

fn find_claude_binary() -> Option<PathBuf> {
    for candidate in candidate_paths() {
        // Follow symlinks (e.g. ~/.local/bin/claude → versions/<ver>).
        let resolved = fs::canonicalize(&candidate).unwrap_or(candidate);
        if resolved.is_file() {
            return Some(resolved);
        }
    }
    None
}

fn candidate_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            out.push(dir.join("claude"));
            #[cfg(windows)]
            out.push(dir.join("claude.exe"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".local/bin/claude"));
        out.push(home.join(".claude/local/claude"));
        #[cfg(windows)]
        {
            out.push(home.join(".local/bin/claude.exe"));
        }
    }
    out.push(PathBuf::from("/usr/local/bin/claude"));
    out.push(PathBuf::from("/opt/homebrew/bin/claude"));
    out
}

/// Scan bytes for model ids inside `.includes("...")` calls that sit within
/// ~500 bytes of a `1e6` literal — the signature of Claude Code's `Ko` helper
/// in the xR(model, betas) context-window lookup.
fn scan_for_1m_models(bytes: &[u8]) -> Vec<String> {
    let one_m_positions = find_all(bytes, b"1e6");
    if one_m_positions.is_empty() {
        return Vec::new();
    }
    let needle = b".includes(\"";
    let mut found: std::collections::BTreeSet<String> = Default::default();
    for pos in find_all(bytes, needle) {
        let start = pos + needle.len();
        let Some(rel_end) = bytes[start..].iter().position(|&b| b == b'"') else {
            continue;
        };
        let end = start + rel_end;
        // Cap literal length — model ids are short.
        if end - start > 80 {
            continue;
        }
        let lit = match std::str::from_utf8(&bytes[start..end]) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if !looks_like_model_id(lit) {
            continue;
        }
        // Proximity guard: require a `1e6` literal within 500 bytes on either side.
        let win_start = pos.saturating_sub(500);
        let win_end = end.saturating_add(500).min(bytes.len());
        let nearby = one_m_positions
            .iter()
            .any(|&p| p >= win_start && p < win_end);
        if !nearby {
            continue;
        }
        found.insert(lit.to_lowercase());
    }
    found.into_iter().collect()
}

fn looks_like_model_id(s: &str) -> bool {
    if s.len() < 5 || s.len() > 80 {
        return false;
    }
    let lower = s.to_ascii_lowercase();
    let has_family =
        lower.contains("opus") || lower.contains("sonnet") || lower.contains("haiku");
    let has_digit = s.chars().any(|c| c.is_ascii_digit());
    has_family && has_digit
}

/// Tiny byte-substring scanner. First-byte check keeps the inner loop close
/// to O(n) on random data, which is what we hit when scanning a 200 MB bundle.
fn find_all(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() || haystack.len() < needle.len() {
        return out;
    }
    let first = needle[0];
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        if haystack[i] == first && &haystack[i..i + needle.len()] == needle {
            out.push(i);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_like_model_id_basic() {
        assert!(looks_like_model_id("opus-4-7"));
        assert!(looks_like_model_id("claude-sonnet-4"));
        assert!(looks_like_model_id("claude-opus-4-6"));
        assert!(looks_like_model_id("haiku-3-5"));
        assert!(!looks_like_model_id("abc"));
        assert!(!looks_like_model_id("context-1m-2025-08-07")); // no family
        assert!(!looks_like_model_id("opus")); // no digit
    }

    #[test]
    fn find_all_finds_every_occurrence() {
        let hay = b"aaXaaXXaa";
        assert_eq!(find_all(hay, b"X"), vec![2, 5, 6]);
        assert_eq!(find_all(hay, b"XX"), vec![5]);
        assert_eq!(find_all(hay, b"ZZ"), Vec::<usize>::new());
    }

    #[test]
    fn scan_extracts_model_ids_near_1e6() {
        // Synthetic pattern matching the Claude Code binary shape.
        let src = br#"function Ko(H){let _=sK(H);return _.includes("claude-sonnet-4")||_.includes("opus-4-6")||_.includes("opus-4-7")}function xR(H,_){if(pJ(H))return 1e6;if(_?.includes(Ho)&&Ko(H))return 1e6;return 200000}"#;
        let mut subs = scan_for_1m_models(src);
        subs.sort();
        assert_eq!(subs, vec!["claude-sonnet-4", "opus-4-6", "opus-4-7"]);
    }

    #[test]
    fn scan_ignores_includes_far_from_1e6() {
        let mut src: Vec<u8> = Vec::new();
        src.extend_from_slice(br#"_.includes("opus-4-7")"#);
        // Push it far away from any `1e6`.
        src.extend(std::iter::repeat(b'.').take(2000));
        src.extend_from_slice(b"1e6");
        let subs = scan_for_1m_models(&src);
        assert!(subs.is_empty(), "expected no match, got {:?}", subs);
    }

    #[test]
    fn scan_rejects_non_model_literals() {
        let src = br#"_.includes("some-unrelated-string")||_.includes("tool-search")return 1e6"#;
        let subs = scan_for_1m_models(src);
        assert!(subs.is_empty(), "expected no model ids, got {:?}", subs);
    }

    #[test]
    fn context_limit_from_subs_matches_substring() {
        let subs = vec!["opus-4-7".to_string(), "sonnet-4".to_string()];
        assert_eq!(
            context_limit_from_subs("claude-opus-4-7", &subs),
            LARGE_CONTEXT_WINDOW
        );
        assert_eq!(
            context_limit_from_subs("claude-sonnet-4-6", &subs),
            LARGE_CONTEXT_WINDOW
        );
        assert_eq!(
            context_limit_from_subs("claude-sonnet-3-5", &subs),
            DEFAULT_CONTEXT_WINDOW
        );
        assert_eq!(
            context_limit_from_subs("claude-haiku-4-5", &subs),
            DEFAULT_CONTEXT_WINDOW
        );
    }

    #[test]
    fn context_limit_for_recognises_brackets_and_synthetic() {
        // These don't depend on binary parsing.
        assert_eq!(
            context_limit_for("claude-sonnet-3-5[1m]"),
            LARGE_CONTEXT_WINDOW
        );
        assert_eq!(context_limit_for("<synthetic>"), LARGE_CONTEXT_WINDOW);
    }

    #[test]
    fn env_override_parses_positive_ints_only() {
        // Guard: if the env var is set in the test environment, this test would
        // report the override. We can't safely mutate process env in parallel
        // tests, so just call the parser-equivalent logic here.
        // (Leaving as a smoke test for the happy path.)
        let n: Option<i64> = "500000"
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|n| *n > 0);
        assert_eq!(n, Some(500_000));
        let bad: Option<i64> = "-1".trim().parse::<i64>().ok().filter(|n| *n > 0);
        assert_eq!(bad, None);
    }
}
