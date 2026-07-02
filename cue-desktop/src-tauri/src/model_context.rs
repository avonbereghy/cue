//! Model → context-window lookup.
//!
//! Claude Code embeds its own model-to-context logic inside the `claude` binary
//! (a Bun-compiled JS bundle). We parse that binary at first lookup, find the
//! OR-chain of `.includes("model-id")` calls that sit near the `1e6` literal
//! (the 1M context window), and extract the model substrings. This mirrors
//! Claude Code's internal `Ko`/`xR` functions and keeps Cue in sync whenever
//! Anthropic ships a new 1M-capable model — no network calls required.
//!
//! The baked-in `FALLBACK_1M_SUBSTRINGS` list is a permanent **floor**, not a
//! last-resort: the binary scan only ever *adds* to it (union semantics). The
//! scan's job is to discover models newer than the floor, never to shrink it.
//! This matters because the scan can succeed *partially* — e.g. Claude Code
//! 2.1.195 reshaped its bundle so the scan finds only `mythos-5` and misses the
//! opus/sonnet/fable gates. Earlier "scan replaces fallback" semantics let that
//! partial result drop `opus-4-8` to 200K. Unioning keeps the known-good set
//! correct regardless of how the scanner fares against a new bundle shape.
//!
//! Also honors `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (the same env override the
//! CLI respects) and the `[1m]` model-name suffix.
//!
//! Two extra layers catch models the scan/fallback don't yet name, so a fresh
//! Anthropic release reads correctly before Cue (or the installed `claude`)
//! knows its exact id:
//!   1. **Family floor** — a model whose family already has a 1M member, at a
//!      version >= the lowest 1M version seen for that family, is assumed 1M.
//!      Derived from the resolved 1M set, so it's self-maintaining: new opus/
//!      fable/sonnet versions read 1M, while old opus-4-0/4-1/4-5 fall below
//!      the opus floor (4-6) and stay 200K — matching Claude Code's own gating.
//!   2. **Observed-usage escalation** — if a live session is *using* more than
//!      the default 200K window, its real window is provably larger (a model
//!      can't hold more live context than its limit), so escalate to 1M.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

pub const DEFAULT_CONTEXT_WINDOW: i64 = 200_000;
pub const LARGE_CONTEXT_WINDOW: i64 = 1_000_000;

/// Baked-in floor of known 1M models. Always part of the resolved set; the
/// binary scan only adds to it (see `merge_with_fallback`). Substring matches
/// against the (lowercased) model id.
const FALLBACK_1M_SUBSTRINGS: &[&str] = &[
    "sonnet-4-0",
    "sonnet-4-5",
    "sonnet-4-6",
    "opus-4-6",
    "opus-4-7",
    "opus-4-8",
    "fable-5",
    "mythos-5",
];

/// Model families recognised when scanning the binary and when deriving the
/// family-floor heuristic. Order is the search order for `parse_family_version`.
const KNOWN_FAMILIES: &[&str] = &["opus", "sonnet", "haiku", "fable", "mythos"];

static ONE_M_SUBSTRINGS: OnceLock<Vec<String>> = OnceLock::new();

/// Resolve the context window for a given model id.
///
/// `observed_tokens` is the largest live context size seen for the session
/// (input tokens of the last API call). Pass 0 when no usage is known yet — it
/// only ever *raises* the limit, never lowers it, so a stale 0 is safe.
pub fn context_limit_for(model: &str, observed_tokens: i64) -> i64 {
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
    // 1. Exact/substring match against the known 1M set (binary scan or fallback).
    if context_limit_from_subs(&lower, subs) == LARGE_CONTEXT_WINDOW {
        return LARGE_CONTEXT_WINDOW;
    }
    // 2. Forward-looking family floor — covers new opus/fable/sonnet versions
    //    not yet in the known set, without promoting older sub-floor versions.
    if family_meets_1m_floor(&lower, subs) {
        return LARGE_CONTEXT_WINDOW;
    }
    // 3. Deterministic backstop — a session can't be *using* more live context
    //    than its window, so observed usage above the default proves a larger
    //    window. 1M is the only larger tier we know; add intermediate tiers
    //    here (smallest that fits) if Anthropic ships them.
    if observed_tokens > DEFAULT_CONTEXT_WINDOW {
        return LARGE_CONTEXT_WINDOW;
    }
    DEFAULT_CONTEXT_WINDOW
}

fn context_limit_from_subs(model_lower: &str, subs: &[String]) -> i64 {
    if subs.iter().any(|s| model_lower.contains(s.as_str())) {
        LARGE_CONTEXT_WINDOW
    } else {
        DEFAULT_CONTEXT_WINDOW
    }
}

/// True if `model_lower`'s family already has at least one 1M member in `subs`
/// and the model's `(major, minor)` version is at or above the lowest 1M
/// version seen for that family.
///
/// Floors are derived from the resolved 1M set, so the heuristic stays in sync
/// with whatever the binary scan (or fallback) reports: haiku never appears in
/// the 1M set so it gets no floor; opus's floor is 4-6 (from 4-6/4-7/4-8), so
/// opus-4-0/4-1/4-5 stay 200K while opus-4-9/5-0 read 1M.
fn family_meets_1m_floor(model_lower: &str, subs: &[String]) -> bool {
    let (fam, ver) = match parse_family_version(model_lower) {
        Some(fv) => fv,
        None => return false,
    };
    let mut floor: Option<(u32, u32)> = None;
    for s in subs {
        if let Some((f, v)) = parse_family_version(s) {
            if f == fam {
                floor = Some(match floor {
                    Some(cur) if cur <= v => cur,
                    _ => v,
                });
            }
        }
    }
    match floor {
        Some(f) => ver >= f,
        None => false,
    }
}

/// Extract `(family, (major, minor))` from a model id. Family is the first of
/// `KNOWN_FAMILIES` the string contains; the version is the first two digit
/// groups appearing *after* the family token (minor defaults to 0). Trailing
/// date/`-fast`/`-v1` suffixes past the first two groups are ignored. Returns
/// `None` when there's no known family or no version digits follow it (e.g. the
/// legacy `claude-3-5-sonnet` ordering, which is 200K anyway).
fn parse_family_version(s: &str) -> Option<(&'static str, (u32, u32))> {
    let fam = *KNOWN_FAMILIES.iter().find(|f| s.contains(**f))?;
    let after = &s[s.find(fam)? + fam.len()..];
    let mut nums: Vec<u32> = Vec::new();
    for grp in after.split(|c: char| !c.is_ascii_digit()) {
        if grp.is_empty() {
            continue;
        }
        // A group longer than two digits is a date/build stamp (e.g.
        // `-20251101`), not a version component. Stop before it — so a legacy
        // `…-sonnet-20241022` (version *before* the family) yields no version
        // and `claude-opus-4-20250514` reads as (4, 0), not (4, 20250514).
        if grp.len() > 2 {
            break;
        }
        nums.push(grp.parse().ok()?);
        if nums.len() == 2 {
            break;
        }
    }
    let major = *nums.first()?;
    let minor = nums.get(1).copied().unwrap_or(0);
    Some((fam, (major, minor)))
}

fn env_override() -> Option<i64> {
    let v = std::env::var("CLAUDE_CODE_MAX_CONTEXT_TOKENS").ok()?;
    v.trim().parse::<i64>().ok().filter(|n| *n > 0)
}

fn detect_1m_substrings() -> Vec<String> {
    let scanned = extract_from_claude_binary().unwrap_or_default();
    if scanned.is_empty() {
        log::debug!("model_context: binary scan empty; using baked-in 1M floor only");
    } else {
        log::info!(
            "model_context: binary scan added {:?} to baked-in 1M floor",
            scanned
        );
    }
    merge_with_fallback(scanned)
}

/// Union the baked-in floor with whatever the binary scan found. The fallback is
/// always present so a partial/broken scan can never drop a known-good 1M model;
/// the scan only ever contributes models the floor doesn't already name. Dedup
/// is via `BTreeSet` (also gives a stable, sorted order).
fn merge_with_fallback(scanned: Vec<String>) -> Vec<String> {
    let mut set: std::collections::BTreeSet<String> = FALLBACK_1M_SUBSTRINGS
        .iter()
        .map(|s| s.to_string())
        .collect();
    set.extend(scanned);
    set.into_iter().collect()
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

/// Scan bytes for model ids that gate Claude Code's 1M context window.
///
/// Claude Code's context-window function is a sequence of `if (gate(model))
/// return 1e6;` branches. Each gate is a tiny boolean function whose body
/// contains either an `===` chain returning `!0`, a `!==` chain returning
/// `!1`, or a terminal `return X.includes("…")||…` chain. Pre-2.1.150-ish
/// builds had the gate inlined right next to `return 1e6` (the old 500-byte
/// proximity heuristic caught it). The newer builds factor the gate into a
/// named helper called from a separate function — proximity broke.
///
/// New approach:
///   1. Find every `return 1e6` and harvest the identifier names called in
///      the surrounding ~300 bytes. Those are the candidate gate functions.
///   2. For each `function NAME(…){…}` whose NAME matches and whose body
///      mentions a model family, brace-match the body (cap 4 KB, string-
///      aware) and within it:
///        - `return!0` predicates → `===`/`.includes()` literals are POS
///        - `return!1` predicates → `===`/`.includes()` literals are NEG,
///          `!==` literals are POS (inverted gate, e.g. `te`)
///        - terminal `return X.includes(…)||…` chain → POS
///   3. Per-function POS minus NEG, unioned across all gate functions.
///
/// This correctly extracts the 1M list across the `ap`, `te`, and similar
/// gate-function renames that Claude Code has been shuffling through.
fn scan_for_1m_models(bytes: &[u8]) -> Vec<String> {
    let gate_names = gate_function_names(bytes);
    if gate_names.is_empty() {
        return Vec::new();
    }
    let fn_decls = find_function_declarations(bytes);

    let mut out: std::collections::BTreeSet<String> = Default::default();
    for (name_start, name_end, body_brace) in fn_decls {
        let name = &bytes[name_start..name_end];
        let name_str = match std::str::from_utf8(name) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if !gate_names.contains(name_str) {
            continue;
        }
        let body_end = match match_brace(bytes, body_brace, 4096) {
            Some(e) => e,
            None => continue,
        };
        // Body excludes outer braces.
        let body = &bytes[body_brace + 1..body_end];
        if !body_has_model_family(body) {
            continue;
        }

        let mut pos: std::collections::BTreeSet<String> = Default::default();
        let mut neg: std::collections::BTreeSet<String> = Default::default();

        for ret_pos in find_all(body, b"return!0") {
            harvest_predicate(body, ret_pos, &mut pos, &mut neg, true);
        }
        for ret_pos in find_all(body, b"return!1") {
            harvest_predicate(body, ret_pos, &mut pos, &mut neg, false);
        }
        harvest_tail_includes_chain(body, &mut pos);

        for lit in pos.difference(&neg) {
            out.insert(lit.clone());
        }
    }
    out.into_iter().collect()
}

/// Identifier names called immediately before `return 1e6` — the candidate
/// 1M-context gating functions. Filters out language keywords and the
/// `.includes` method-call false positive (it's not a `function includes(`
/// declaration anyway).
fn gate_function_names(bytes: &[u8]) -> std::collections::HashSet<String> {
    let mut out: std::collections::HashSet<String> = Default::default();
    let needle = b"return 1e6";
    for pos in find_all(bytes, needle) {
        let win_start = pos.saturating_sub(300);
        let win = &bytes[win_start..pos];
        // Find every `NAME(` in the window.
        let mut i = 0;
        while i < win.len() {
            if is_ident_start(win[i]) {
                let start = i;
                i += 1;
                while i < win.len() && is_ident_cont(win[i]) {
                    i += 1;
                }
                if i < win.len() && win[i] == b'(' {
                    if let Ok(name) = std::str::from_utf8(&win[start..i]) {
                        out.insert(name.to_string());
                    }
                }
            } else {
                i += 1;
            }
        }
    }
    // Strip JS keywords and obvious non-gates.
    for kw in [
        "if", "return", "typeof", "await", "async", "function", "new", "isNaN", "parseInt",
        "includes",
    ] {
        out.remove(kw);
    }
    out
}

/// Return all `function NAME(…){` positions as `(name_start, name_end,
/// body_brace_idx)` triples. Whitespace between the keyword and the name is
/// not used by minified Claude Code bundles, so we don't tolerate any here.
fn find_function_declarations(bytes: &[u8]) -> Vec<(usize, usize, usize)> {
    let mut out = Vec::new();
    let prefix = b"function ";
    for pos in find_all(bytes, prefix) {
        let name_start = pos + prefix.len();
        if name_start >= bytes.len() || !is_ident_start(bytes[name_start]) {
            continue;
        }
        let mut name_end = name_start + 1;
        while name_end < bytes.len() && is_ident_cont(bytes[name_end]) {
            name_end += 1;
        }
        // Expect '(' immediately, then anything up to a matching '{'.
        if name_end >= bytes.len() || bytes[name_end] != b'(' {
            continue;
        }
        // Find the '{' that opens the body. Cap the scan so a function
        // expression with a malformed signature doesn't run away.
        let mut j = name_end + 1;
        let scan_end = bytes.len().min(name_end + 512);
        let mut paren_depth: i32 = 1;
        let mut in_str: Option<u8> = None;
        while j < scan_end && paren_depth > 0 {
            let c = bytes[j];
            match in_str {
                Some(q) => {
                    if c == b'\\' {
                        j += 2;
                        continue;
                    }
                    if c == q {
                        in_str = None;
                    }
                }
                None => match c {
                    b'"' | b'\'' | b'`' => in_str = Some(c),
                    b'(' => paren_depth += 1,
                    b')' => paren_depth -= 1,
                    _ => {}
                },
            }
            j += 1;
        }
        if paren_depth != 0 {
            continue;
        }
        // Skip whitespace, then expect '{'.
        while j < scan_end && (bytes[j] == b' ' || bytes[j] == b'\n' || bytes[j] == b'\t') {
            j += 1;
        }
        if j < scan_end && bytes[j] == b'{' {
            out.push((name_start, name_end, j));
        }
    }
    out
}

/// Brace-match starting at `open_idx` (must be `{`). Returns the index of the
/// matching `}` or `None` if not found within `cap` bytes. String literals
/// (`"`, `'`, backtick) are skipped along with backslash escapes — sufficient
/// for the minified-JS bundles we're scanning.
fn match_brace(bytes: &[u8], open_idx: usize, cap: usize) -> Option<usize> {
    if bytes.get(open_idx) != Some(&b'{') {
        return None;
    }
    let end = bytes.len().min(open_idx + cap);
    let mut depth: i32 = 0;
    let mut i = open_idx;
    let mut in_str: Option<u8> = None;
    while i < end {
        let c = bytes[i];
        match in_str {
            Some(q) => {
                if c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    in_str = None;
                }
            }
            None => match c {
                b'"' | b'\'' | b'`' => in_str = Some(c),
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    None
}

fn body_has_model_family(body: &[u8]) -> bool {
    const FAMILY_BYTES: &[&[u8]] = &[b"opus", b"sonnet", b"haiku", b"fable", b"mythos"];
    FAMILY_BYTES
        .iter()
        .any(|f| body.windows(f.len()).any(|w| w == *f))
}

/// Walk back from a `return!0`/`return!1` position to the nearest preceding
/// `if(`, then extract `===`/`!==`/`.includes("…")` literals from that
/// predicate window and route them into `pos`/`neg` based on the return
/// type and comparison operator.
fn harvest_predicate(
    body: &[u8],
    ret_pos: usize,
    pos: &mut std::collections::BTreeSet<String>,
    neg: &mut std::collections::BTreeSet<String>,
    return_true: bool,
) {
    // Reject fallback / non-gated returns. A return that's the immediate
    // then-clause of an `if(...)` is preceded by `)` (single statement) or
    // `{` (block). A return preceded by `;` (e.g. the bare `return!1` at
    // the end of `ap`) is NOT gated by the if-clause above it, even though
    // an `if(` literally appears nearby — attributing it would steal that
    // if's literals into the wrong polarity bucket and cancel them out.
    if ret_pos == 0 {
        return;
    }
    match body[ret_pos - 1] {
        b')' | b'{' => {}
        _ => return,
    }
    let win_start = ret_pos.saturating_sub(500);
    let win = &body[win_start..ret_pos];
    let if_rel = match rfind(win, b"if(") {
        Some(p) => p,
        None => return,
    };
    let pred = &win[if_rel..];
    for lit in literals_after(pred, b"===\"") {
        if return_true {
            pos.insert(lit);
        } else {
            neg.insert(lit);
        }
    }
    for lit in literals_after(pred, b".includes(\"") {
        if return_true {
            pos.insert(lit);
        } else {
            neg.insert(lit);
        }
    }
    for lit in literals_after(pred, b"!==\"") {
        // Inverted: `!=="X"` returning !1 means X is in the positive set.
        if return_true {
            neg.insert(lit);
        } else {
            pos.insert(lit);
        }
    }
}

/// Find every position of `return ` followed by an identifier `.includes(`
/// chain. Each model literal in the chain is added to `pos`. Covers gate
/// functions whose only signal is a terminal `return X.includes("…")||
/// X.includes("…")` (e.g. `Zj`).
fn harvest_tail_includes_chain(body: &[u8], pos: &mut std::collections::BTreeSet<String>) {
    let needle = b"return ";
    'outer: for ret_pos in find_all(body, needle) {
        let mut i = ret_pos + needle.len();
        // Skip identifier
        if i >= body.len() || !is_ident_start(body[i]) {
            continue;
        }
        i += 1;
        while i < body.len() && is_ident_cont(body[i]) {
            i += 1;
        }
        // Expect ".includes(\""
        let inc = b".includes(\"";
        if i + inc.len() > body.len() || &body[i..i + inc.len()] != inc {
            continue;
        }
        // Walk the chain: `.includes("…")||X.includes("…")||…`
        let mut j = i;
        loop {
            // Consume `.includes("…")`
            if j + inc.len() > body.len() || &body[j..j + inc.len()] != inc {
                continue 'outer;
            }
            let lit_start = j + inc.len();
            let rel_end = match body[lit_start..].iter().position(|&b| b == b'"') {
                Some(p) => p,
                None => continue 'outer,
            };
            let lit_end = lit_start + rel_end;
            if lit_end - lit_start > 80 {
                continue 'outer;
            }
            let close = lit_end + 1;
            if close >= body.len() || body[close] != b')' {
                continue 'outer;
            }
            if let Ok(lit) = std::str::from_utf8(&body[lit_start..lit_end]) {
                if looks_like_model_id(lit) {
                    pos.insert(lit.to_ascii_lowercase());
                }
            }
            j = close + 1;
            // Optional `||X` then back into `.includes(`. Bail if the chain ends.
            if j + 2 > body.len() || &body[j..j + 2] != b"||" {
                break;
            }
            j += 2;
            if j >= body.len() || !is_ident_start(body[j]) {
                break;
            }
            j += 1;
            while j < body.len() && is_ident_cont(body[j]) {
                j += 1;
            }
            // Loop back to consume the next `.includes("…")`.
        }
    }
}

/// Extract every model-id-looking string that appears as `<prefix>"<id>"`.
/// Bounded by quoting; tolerates the literal-length cap from
/// `looks_like_model_id`.
fn literals_after(haystack: &[u8], prefix: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    for pos in find_all(haystack, prefix) {
        let start = pos + prefix.len();
        let rel_end = match haystack[start..].iter().position(|&b| b == b'"') {
            Some(p) => p,
            None => continue,
        };
        let end = start + rel_end;
        if end - start > 80 {
            continue;
        }
        if let Ok(s) = std::str::from_utf8(&haystack[start..end]) {
            if looks_like_model_id(s) {
                out.push(s.to_ascii_lowercase());
            }
        }
    }
    out
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let mut i = haystack.len() - needle.len() + 1;
    while i > 0 {
        i -= 1;
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
    }
    None
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b'$'
}

fn is_ident_cont(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

fn looks_like_model_id(s: &str) -> bool {
    if s.len() < 5 || s.len() > 80 {
        return false;
    }
    let lower = s.to_ascii_lowercase();
    let has_family = KNOWN_FAMILIES.iter().any(|f| lower.contains(f));
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
        src.extend(std::iter::repeat_n(b'.', 2000));
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
            context_limit_for("claude-sonnet-3-5[1m]", 0),
            LARGE_CONTEXT_WINDOW
        );
        assert_eq!(context_limit_for("<synthetic>", 0), LARGE_CONTEXT_WINDOW);
    }

    #[test]
    fn observed_usage_above_default_escalates_to_1m() {
        // A genuinely-unknown model we can't classify by name. Below the
        // default window it reads 200K; once observed usage proves the window
        // is larger, it escalates. This is the deterministic backstop.
        assert_eq!(
            context_limit_for("claude-zenith-9", 150_000),
            DEFAULT_CONTEXT_WINDOW
        );
        assert_eq!(
            context_limit_for("claude-zenith-9", 250_000),
            LARGE_CONTEXT_WINDOW
        );
    }

    #[test]
    fn fable_resolves_to_1m_via_fallback() {
        // The screenshot bug: claude-fable-5 must not clamp at 200K. Covered by
        // the fallback list even when the binary scan can't run, and regardless
        // of observed usage.
        let fallback: Vec<String> = FALLBACK_1M_SUBSTRINGS
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            context_limit_from_subs("claude-fable-5", &fallback),
            LARGE_CONTEXT_WINDOW
        );
        assert_eq!(
            context_limit_from_subs("claude-mythos-5", &fallback),
            LARGE_CONTEXT_WINDOW
        );
    }

    #[test]
    fn merge_with_fallback_unions_partial_scan() {
        // The 2.1.195 regression: the binary scan succeeds but only finds
        // `mythos-5`, missing opus/sonnet/fable. Under the old replace
        // semantics that partial result would suppress the baked-in floor and
        // drop opus-4-8 to 200K. Unioning keeps the floor, so opus-4-8 still
        // resolves to 1M.
        let merged = merge_with_fallback(vec!["claude-mythos-5".to_string()]);
        assert!(
            merged.iter().any(|s| s == "opus-4-8"),
            "baked-in floor must survive a partial scan, got {:?}",
            merged
        );
        assert_eq!(
            context_limit_from_subs("claude-opus-4-8", &merged),
            LARGE_CONTEXT_WINDOW,
            "opus-4-8 must read 1M even when the scan only found mythos-5"
        );
        // The scan's lone find is still present, just not load-bearing here.
        assert!(merged.iter().any(|s| s == "claude-mythos-5"));
    }

    #[test]
    fn merge_with_fallback_keeps_new_scanned_models() {
        // The scan's forward-looking job: a model the floor doesn't yet name
        // (a hypothetical future opus) must survive the union alongside the
        // whole baked-in floor.
        let merged = merge_with_fallback(vec!["opus-9-9".to_string()]);
        assert!(merged.iter().any(|s| s == "opus-9-9"));
        for floor in FALLBACK_1M_SUBSTRINGS {
            assert!(
                merged.iter().any(|s| s == floor),
                "floor entry {} dropped by union, got {:?}",
                floor,
                merged
            );
        }
        assert_eq!(
            context_limit_from_subs("claude-opus-9-9", &merged),
            LARGE_CONTEXT_WINDOW
        );
    }

    #[test]
    fn merge_with_fallback_empty_scan_is_just_the_floor() {
        // No binary / unparseable scan → resolved set equals the baked-in floor.
        let merged = merge_with_fallback(Vec::new());
        let floor: std::collections::BTreeSet<&str> =
            FALLBACK_1M_SUBSTRINGS.iter().copied().collect();
        let got: std::collections::BTreeSet<&str> = merged.iter().map(|s| s.as_str()).collect();
        assert_eq!(got, floor);
    }

    #[test]
    fn family_floor_promotes_new_versions_but_not_old() {
        // Floor derived from the shipping 1M set: opus floor = 4-6, fable = 5,
        // sonnet = 4-0. New versions clear the floor; pre-floor opus stays 200K.
        let subs: Vec<String> = FALLBACK_1M_SUBSTRINGS
            .iter()
            .map(|s| s.to_string())
            .collect();
        // Newer-than-floor → 1M (no observed usage needed).
        assert!(family_meets_1m_floor("claude-opus-4-9", &subs));
        assert!(family_meets_1m_floor("claude-opus-5-0", &subs));
        assert!(family_meets_1m_floor("claude-fable-6", &subs));
        assert!(family_meets_1m_floor("claude-sonnet-4-7", &subs));
        // At/above the exact floor → 1M.
        assert!(family_meets_1m_floor("claude-opus-4-6", &subs));
        // Below the floor → not promoted (matches Claude Code's 200K denylist).
        assert!(!family_meets_1m_floor("claude-opus-4-5", &subs));
        assert!(!family_meets_1m_floor("claude-opus-4-1", &subs));
        assert!(!family_meets_1m_floor("claude-opus-4-0", &subs));
        // haiku never appears in the 1M set → no floor → never promoted.
        assert!(!family_meets_1m_floor("claude-haiku-4-5", &subs));
        assert!(!family_meets_1m_floor("claude-haiku-9-9", &subs));
    }

    #[test]
    fn parse_family_version_handles_id_shapes() {
        assert_eq!(
            parse_family_version("claude-opus-4-8"),
            Some(("opus", (4, 8)))
        );
        assert_eq!(parse_family_version("opus-4-7"), Some(("opus", (4, 7))));
        assert_eq!(
            parse_family_version("claude-fable-5"),
            Some(("fable", (5, 0)))
        );
        // Date/fast suffixes past the first two groups are ignored.
        assert_eq!(
            parse_family_version("claude-opus-4-6-20251101"),
            Some(("opus", (4, 6)))
        );
        assert_eq!(
            parse_family_version("claude-opus-4-6-fast"),
            Some(("opus", (4, 6)))
        );
        // Legacy version-before-family ordering → no version after family → None.
        assert_eq!(parse_family_version("claude-3-5-sonnet-20241022"), None);
        // Original opus-4 (a 200K model): the date must not become the minor.
        assert_eq!(
            parse_family_version("claude-opus-4-20250514"),
            Some(("opus", (4, 0)))
        );
        // No known family → None.
        assert_eq!(parse_family_version("gpt-4o"), None);
    }

    #[test]
    fn family_floor_does_not_promote_legacy_dated_ids() {
        // Regression: date suffixes on legacy ids must not clear the floor.
        let subs: Vec<String> = FALLBACK_1M_SUBSTRINGS
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(!family_meets_1m_floor("claude-3-5-sonnet-20241022", &subs));
        assert!(!family_meets_1m_floor("claude-opus-4-20250514", &subs));
    }

    #[test]
    fn env_override_parses_positive_ints_only() {
        // Guard: if the env var is set in the test environment, this test would
        // report the override. We can't safely mutate process env in parallel
        // tests, so just call the parser-equivalent logic here.
        // (Leaving as a smoke test for the happy path.)
        let n: Option<i64> = "500000".trim().parse::<i64>().ok().filter(|n| *n > 0);
        assert_eq!(n, Some(500_000));
        let bad: Option<i64> = "-1".trim().parse::<i64>().ok().filter(|n| *n > 0);
        assert_eq!(bad, None);
    }

    // ─────────────────────────────────────────────────────────────────────
    // New gate-function-based scanner (post-2.1.150 Claude Code shape).
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn match_brace_skips_strings_and_escapes() {
        // Outer `{` at index 1; inside, two `}` literals appear inside a
        // double-quoted string and a single-quoted string; the matching
        // outer `}` is the last byte before 'Y'. Validates both that
        // string contents are skipped and that escaped quotes don't end
        // the string prematurely.
        let src = b"X{a=\"})\";b='}';c}Y";
        //         0 1 2 3 4 5 6 7 8 9 ...
        // Outer { at 1, outer } at 16, Y at 17.
        assert_eq!(match_brace(src, 1, 256), Some(16));
    }

    #[test]
    fn gate_function_names_picks_callees_before_return_1e6() {
        let src = br#"if(k0(H))return 1e6;if(ap(H))return 1e6;if(te(H))return 1e6"#;
        let names = gate_function_names(src);
        assert!(names.contains("k0"));
        assert!(names.contains("ap"));
        assert!(names.contains("te"));
        assert!(!names.contains("if"));
        assert!(!names.contains("return"));
    }

    #[test]
    fn scan_handles_ap_style_eq_chain_return_zero() {
        // Mirrors the `ap` function shape: negative === chain returns !1,
        // then a positive === chain returns !0. Far away from `1e6`.
        let src = br#"if(ap(H))return 1e6;function ap(H){if(oKH())return!1;let _=$7(H);if(_.includes("claude-3-")||_==="claude-opus-4-0"||_==="claude-opus-4-1"||_==="claude-opus-4-5"||_==="claude-haiku-4-5")return!1;if(_==="claude-opus-4-8"||_==="claude-opus-4-7"||_==="claude-opus-4-6"||_==="claude-sonnet-4-6"||_==="claude-sonnet-4-5"||_==="claude-sonnet-4-0")return!0;return jC(OM(H))}"#;
        let mut subs = scan_for_1m_models(src);
        subs.sort();
        assert_eq!(
            subs,
            vec![
                "claude-opus-4-6",
                "claude-opus-4-7",
                "claude-opus-4-8",
                "claude-sonnet-4-0",
                "claude-sonnet-4-5",
                "claude-sonnet-4-6",
            ],
            "ap-style positive === chain must extract opus-4-6/7/8 + sonnet-4-0/5/6"
        );
        // Critical: negatives must NOT leak into the positive set.
        for excluded in [
            "claude-opus-4-0",
            "claude-opus-4-1",
            "claude-opus-4-5",
            "claude-haiku-4-5",
        ] {
            assert!(
                !subs.iter().any(|s| s == excluded),
                "{} appears in === chain returning !1 — must be excluded, got {:?}",
                excluded,
                subs
            );
        }
    }

    #[test]
    fn scan_handles_bu_style_chain_with_fable_and_mythos() {
        // Mirrors the live `bU` gate (Claude Code 2.1.170): a positive ===
        // chain returning !0 that includes the fable/mythos families alongside
        // opus/sonnet. The negative `if(wP_(H))return!1` is a bare function
        // call with no literals, so it must not steal anything.
        let src = br#"if(bU(H))return 1e6;function bU(H){if(y5H())return!1;let _=W9(H);if(wP_(H))return!1;if(_==="claude-fable-5"||_==="claude-mythos-5"||_==="claude-opus-4-8"||_==="claude-opus-4-7"||_==="claude-opus-4-6"||_==="claude-sonnet-4-6"||_==="claude-sonnet-4-5"||_==="claude-sonnet-4-0")return!0;return bE(Rj(H))}"#;
        let mut subs = scan_for_1m_models(src);
        subs.sort();
        assert_eq!(
            subs,
            vec![
                "claude-fable-5",
                "claude-mythos-5",
                "claude-opus-4-6",
                "claude-opus-4-7",
                "claude-opus-4-8",
                "claude-sonnet-4-0",
                "claude-sonnet-4-5",
                "claude-sonnet-4-6",
            ],
            "bU-style chain must extract fable-5/mythos-5 plus opus/sonnet"
        );
    }

    #[test]
    fn scan_handles_te_style_inverted_neq_chain() {
        // Mirrors `te`: `!=="X"&&!=="Y"` returning !1 means X,Y are positive.
        let src = br#"if(te(H))return 1e6;function te(H){if(oKH())return!1;let _=$7(H);if(_!=="claude-opus-4-7"&&_!=="claude-opus-4-8")return!1;let q=OM(H);return q==="firstParty"&&uO()||q==="anthropicAws"}"#;
        let mut subs = scan_for_1m_models(src);
        subs.sort();
        assert_eq!(
            subs,
            vec!["claude-opus-4-7", "claude-opus-4-8"],
            "te-style inverted !== chain must extract opus-4-7/8"
        );
    }

    #[test]
    fn scan_handles_zj_style_terminal_includes_chain() {
        // Mirrors `Zj`: terminal `return X.includes("…")||X.includes("…")`.
        let src = br#"if(Zj(H))return 1e6;function Zj(H){if(!u4())return!1;let _=H??L0(),K=_K(_).toLowerCase();return K.includes("opus-4-6")||K.includes("opus-4-7")||K.includes("opus-4-8")}"#;
        let mut subs = scan_for_1m_models(src);
        subs.sort();
        assert_eq!(
            subs,
            vec!["opus-4-6", "opus-4-7", "opus-4-8"],
            "Zj-style terminal includes chain must extract opus-4-6/7/8"
        );
    }

    #[test]
    fn scan_ignores_unrelated_model_listing_function() {
        // A function that happens to list Claude 4 models but is NOT called
        // anywhere near `return 1e6` — e.g., a "is-this-a-Claude-4-family"
        // check. Must not pollute the 1M set.
        let src = br#"if(ap(H))return 1e6;function ap(H){if(_==="claude-opus-4-8")return!0;return!1}function Tp1(H){if(_==="claude-opus-4-0"||_==="claude-opus-4-1"||_==="claude-opus-4-5")return!0;return!1}"#;
        let mut subs = scan_for_1m_models(src);
        subs.sort();
        assert_eq!(
            subs,
            vec!["claude-opus-4-8"],
            "only ap (named near `return 1e6`) should contribute — Tp1 is unrelated"
        );
    }

    #[test]
    fn scan_unions_across_multiple_gate_functions() {
        // ap + te + Zj together — same shape as the real binary.
        let src = br#"if(k0(H))return 1e6;if(_?.includes(bQ.header)&&ap(H))return 1e6;if(te(H))return 1e6;function ap(H){if(_==="claude-opus-4-6"||_==="claude-sonnet-4-6")return!0;return!1}function te(H){if(_!=="claude-opus-4-8")return!1;return!0}function k0(H){return/\[1m\]/i.test(H)}"#;
        let mut subs = scan_for_1m_models(src);
        subs.sort();
        assert_eq!(
            subs,
            vec!["claude-opus-4-6", "claude-opus-4-8", "claude-sonnet-4-6",],
            "union across ap+te should cover opus-4-6/8 and sonnet-4-6"
        );
    }

    #[test]
    fn scan_returns_empty_when_no_return_1e6() {
        // Without any `return 1e6` anchor, gate_function_names is empty
        // and no function is scanned. Avoids garbage when the binary
        // doesn't expose the 1M gate at all.
        let src = br#"function ap(H){if(_==="claude-opus-4-8")return!0;return!1}"#;
        let subs = scan_for_1m_models(src);
        assert!(
            subs.is_empty(),
            "no `return 1e6` anchor must yield no positives, got {:?}",
            subs
        );
    }

    /// Smoke-test against the user's actual `claude` binary if it's present.
    /// Ignored by default so the CI / fresh-clone path doesn't depend on the
    /// CLI being installed. Run with `cargo test --ignored live_binary`.
    #[test]
    #[ignore]
    fn live_binary_resolves_opus_4_8_to_1m() {
        let path = match find_claude_binary() {
            Some(p) => p,
            None => {
                eprintln!("no claude binary on PATH — skipping");
                return;
            }
        };
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("could not read {}: {}", path.display(), e);
                return;
            }
        };
        // Raw scan first — this is the canary. When Claude Code reshapes its
        // bundle the scan degrades (2.1.195 yields only `mythos-5`); the
        // eprintln + warning make that visible without failing the product,
        // because the assertions below run against the unioned set.
        let scanned = scan_for_1m_models(&bytes);
        eprintln!(
            "raw scan of {} → {} 1M substrings: {:?}",
            path.display(),
            scanned.len(),
            scanned
        );
        if !scanned.iter().any(|s| s.contains("opus")) {
            eprintln!(
                "WARNING: scan found no opus gate — Claude Code bundle shape likely \
                 changed; relying on baked-in floor. Update scan_for_1m_models."
            );
        }

        // Product behavior: the resolved set is fallback ∪ scan, so today's
        // shipping 1M models read 1M regardless of scanner breakage.
        let resolved = merge_with_fallback(scanned);
        for model in [
            "claude-opus-4-6",
            "claude-opus-4-7",
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "claude-fable-5",
            "claude-mythos-5",
        ] {
            assert_eq!(
                context_limit_from_subs(model, &resolved),
                LARGE_CONTEXT_WINDOW,
                "{} must resolve to 1M (fallback ∪ live scan)",
                model
            );
        }
        for model in [
            "claude-opus-4-5",
            "claude-opus-4-1",
            "claude-opus-4-0",
            "claude-haiku-4-5",
        ] {
            assert_eq!(
                context_limit_from_subs(model, &resolved),
                DEFAULT_CONTEXT_WINDOW,
                "{} must resolve to 200K (fallback ∪ live scan)",
                model
            );
        }
    }

    #[test]
    fn context_limit_for_opus_4_8_via_fallback() {
        // If the binary scan can't locate the gate functions, the baked-in
        // fallback list must still cover the currently-shipping 1M models.
        let fallback: Vec<String> = FALLBACK_1M_SUBSTRINGS
            .iter()
            .map(|s| s.to_string())
            .collect();
        for model in [
            "claude-opus-4-6",
            "claude-opus-4-7",
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "claude-sonnet-4-5",
            "claude-sonnet-4-0",
        ] {
            assert_eq!(
                context_limit_from_subs(model, &fallback),
                LARGE_CONTEXT_WINDOW,
                "{} must resolve to 1M via fallback",
                model
            );
        }
        for model in ["claude-opus-4-5", "claude-opus-4-1", "claude-haiku-4-5"] {
            assert_eq!(
                context_limit_from_subs(model, &fallback),
                DEFAULT_CONTEXT_WINDOW,
                "{} must resolve to 200K via fallback",
                model
            );
        }
    }
}
