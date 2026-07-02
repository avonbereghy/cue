//! Localhost HTTP server for Claude Code PermissionRequest hooks.
//!
//! Listens on 127.0.0.1:{port} for POST /permission-request from Claude Code.
//! Holds the HTTP connection open until the user approves/denies via the dashboard.
//! GET /health returns 200 for testing.

use crate::models::PermissionDecision;
use crate::session_monitor::LockSafe;
use crate::{paths, security};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tokio::sync::oneshot;

/// Pending permission requests awaiting user decision.
pub struct PendingRequests {
    requests: Mutex<HashMap<String, oneshot::Sender<PermissionDecision>>>,
}

/// Hard cap on concurrently-pending permission requests. A flood of requests
/// from a hostile local process would otherwise grow this map without bound
/// along with the corresponding Tokio tasks and oneshot channels.
const MAX_PENDING: usize = 64;

impl Default for PendingRequests {
    fn default() -> Self {
        Self::new()
    }
}

impl PendingRequests {
    pub fn new() -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
        }
    }

    /// Store a pending request and return a receiver for the decision.
    /// Returns None if the pending-request cap is already saturated; callers
    /// should respond 503 and drop the connection.
    pub fn insert(&self, request_id: &str) -> Option<oneshot::Receiver<PermissionDecision>> {
        let mut map = self.requests.lock_safe();
        if map.len() >= MAX_PENDING {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        map.insert(request_id.to_string(), tx);
        Some(rx)
    }

    /// Resolve a pending request with a decision.
    pub fn resolve(&self, request_id: &str, decision: PermissionDecision) -> Result<(), String> {
        let sender = self
            .requests
            .lock_safe()
            .remove(request_id)
            .ok_or_else(|| format!("No pending request: {}", request_id))?;
        sender
            .send(decision)
            .map_err(|_| "Receiver dropped".to_string())
    }

    /// Check if a request is still pending.
    pub fn is_pending(&self, request_id: &str) -> bool {
        self.requests.lock_safe().contains_key(request_id)
    }

    /// Remove a request without resolving (e.g., on timeout).
    pub fn remove(&self, request_id: &str) {
        self.requests.lock_safe().remove(request_id);
    }

    /// Return the number of currently pending requests.
    pub fn len(&self) -> usize {
        self.requests.lock_safe().len()
    }

    /// Return true if there are no pending requests.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// HTTP JSON response body for an Allow decision.
pub const ALLOW_RESPONSE: &str = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#;

/// HTTP JSON response body for a Deny decision.
pub const DENY_RESPONSE: &str = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}"#;

/// HTTP header name the Python hook sends to authenticate to this server.
/// Matched case-insensitively against incoming request headers.
pub const TOKEN_HEADER: &str = "x-cue-token";

/// HTTP header name the server returns to authenticate ITSELF to the hook
/// (F-security-001). Carries `resp_token`, which the hook never transmits.
pub const PROOF_HEADER: &str = "X-Cue-Proof";

/// The two per-launch secrets that authenticate the hook↔server channel in
/// BOTH directions.
///
/// - `req_token` — the hook sends it in `X-Cue-Token`; the server verifies it
///   so a rogue *client* can't POST forged prompts (inbound auth, pre-existing).
/// - `resp_token` — the server returns it in `X-Cue-Proof`; the hook verifies
///   it so a rogue *server* that won the loopback port can't forge an "allow"
///   (outbound auth, the F-security-001 fix). Because the hook only ever READS
///   `resp_token` from its 0600 file and never sends it, a different-uid
///   attacker never learns it — even though the hook does hand `req_token` to
///   whatever process answers on 3002.
pub struct ServerSecrets {
    pub req_token: String,
    pub resp_token: String,
}

/// Generate two fresh 128-bit per-launch secrets, atomically write each to its
/// own 0600 file (`permission-token`, `permission-proof`) under the user's
/// 0700 status dir, and return them.
///
/// MUST be called only AFTER the server has successfully bound `127.0.0.1:3002`
/// (F-security-001): provisioning before the bind, or leaving the files behind
/// when Cue isn't the process on 3002, lets the hook forward `req_token` to a
/// rogue server. Pair with `remove_secrets()` on bind failure, when permissions
/// are disabled, and on shutdown so "secret files exist ⟺ Cue is serving"
/// holds outside a hard crash — and `resp_token` closes even the crash window.
pub fn provision_secrets() -> std::io::Result<ServerSecrets> {
    provision_secrets_at(
        &paths::permission_token_path(),
        &paths::permission_proof_path(),
    )
}

/// Path-injectable core of `provision_secrets` (for tests — the public wrapper
/// targets the real status dir).
fn provision_secrets_at(token_path: &Path, proof_path: &Path) -> std::io::Result<ServerSecrets> {
    // 16 bytes of OS CSPRNG output via getrandom (same source uuid::new_v4
    // pulls from), hex-encoded to 32 ASCII chars so each survives an HTTP
    // header round-trip without escaping concerns.
    let req_token = uuid::Uuid::new_v4().simple().to_string();
    let resp_token = uuid::Uuid::new_v4().simple().to_string();

    security::atomic_write(token_path, req_token.as_bytes())?;
    // If the proof write fails, don't leave a lone token file behind (it would
    // authenticate a rogue server to an old hook); clean up and propagate.
    if let Err(e) = security::atomic_write(proof_path, resp_token.as_bytes()) {
        remove_secrets_at(token_path, proof_path);
        return Err(e);
    }
    Ok(ServerSecrets {
        req_token,
        resp_token,
    })
}

/// Best-effort deletion of both secret files. Called when Cue is NOT serving
/// on 3002 (bind failure, permissions disabled, shutdown) so a stale, still
/// valid `req_token` can't drive the hook to forward to an impostor.
pub fn remove_secrets() {
    remove_secrets_at(
        &paths::permission_token_path(),
        &paths::permission_proof_path(),
    );
}

fn remove_secrets_at(token_path: &Path, proof_path: &Path) {
    let _ = std::fs::remove_file(token_path);
    let _ = std::fs::remove_file(proof_path);
}

/// Read a previously-provisioned token from `path`. Used only by the test
/// suite; the live server keeps the token in memory after `provision_token`
/// rather than re-reading on every request.
#[cfg(test)]
pub fn read_token(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    String::from_utf8(bytes).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Constant-time comparison of two byte slices.
///
/// `==` short-circuits on the first differing byte, which leaks a side
/// channel: an attacker who can observe response latency (even local-loopback
/// noisy timing is usable across thousands of probes) could byte-by-byte
/// reconstruct the token. This compare always touches every byte and only
/// returns equality once both lengths and contents match.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// Silence dead_code warnings when only the test suite uses the helper above.
#[allow(dead_code)]
fn _ensure_paths_referenced(_: &Path) {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_insert_and_resolve_allow() {
        let pending = PendingRequests::new();
        let rx = pending.insert("req-1").unwrap();

        assert!(pending.is_pending("req-1"));
        assert_eq!(pending.len(), 1);

        pending.resolve("req-1", PermissionDecision::Allow).unwrap();

        let decision = rx.await.unwrap();
        assert_eq!(decision, PermissionDecision::Allow);
        assert!(!pending.is_pending("req-1"));
    }

    #[tokio::test]
    async fn test_insert_and_resolve_deny() {
        let pending = PendingRequests::new();
        let rx = pending.insert("req-2").unwrap();

        pending.resolve("req-2", PermissionDecision::Deny).unwrap();

        let decision = rx.await.unwrap();
        assert_eq!(decision, PermissionDecision::Deny);
    }

    #[test]
    fn test_resolve_nonexistent_request() {
        let pending = PendingRequests::new();
        let result = pending.resolve("nonexistent", PermissionDecision::Allow);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No pending request"));
    }

    #[test]
    fn test_is_pending() {
        let pending = PendingRequests::new();
        assert!(!pending.is_pending("req-x"));

        let _rx = pending.insert("req-x").unwrap();
        assert!(pending.is_pending("req-x"));
    }

    #[test]
    fn test_remove() {
        let pending = PendingRequests::new();
        let _rx = pending.insert("req-r").unwrap();
        assert!(pending.is_pending("req-r"));

        pending.remove("req-r");
        assert!(!pending.is_pending("req-r"));
        assert!(pending.is_empty());
    }

    #[test]
    fn test_remove_nonexistent_does_not_panic() {
        let pending = PendingRequests::new();
        pending.remove("does-not-exist"); // should not panic
    }

    #[test]
    fn test_multiple_pending_requests() {
        let pending = PendingRequests::new();
        let _rx1 = pending.insert("a").unwrap();
        let _rx2 = pending.insert("b").unwrap();
        let _rx3 = pending.insert("c").unwrap();

        assert_eq!(pending.len(), 3);
        assert!(!pending.is_empty());

        pending.remove("b");
        assert_eq!(pending.len(), 2);
        assert!(pending.is_pending("a"));
        assert!(!pending.is_pending("b"));
        assert!(pending.is_pending("c"));
    }

    #[test]
    fn test_insert_returns_none_at_cap() {
        // F-tests-003: the MAX_PENDING flood backstop. A hostile local process
        // spamming permission requests must not grow the map (and its tokio
        // tasks + oneshot channels) without bound — insert returns None at the
        // cap so the caller can 503 and drop the connection.
        let pending = PendingRequests::new();
        let mut held = Vec::new();
        for i in 0..MAX_PENDING {
            let rx = pending
                .insert(&format!("req-{i}"))
                .expect("inserts below the cap succeed");
            held.push(rx);
        }
        assert_eq!(pending.len(), MAX_PENDING);
        // The next insert is over the cap.
        assert!(
            pending.insert("over-the-cap").is_none(),
            "insert past MAX_PENDING must return None"
        );
        assert_eq!(pending.len(), MAX_PENDING, "a rejected insert adds nothing");

        // Freeing one slot lets a new request in again.
        pending.remove("req-0");
        assert_eq!(pending.len(), MAX_PENDING - 1);
        assert!(
            pending.insert("after-release").is_some(),
            "a slot freed below the cap accepts a new request"
        );
        assert_eq!(pending.len(), MAX_PENDING);
    }

    #[test]
    fn test_format_allow_response() {
        let parsed: serde_json::Value = serde_json::from_str(ALLOW_RESPONSE).unwrap();
        assert_eq!(
            parsed["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(
            parsed["hookSpecificOutput"]["decision"]["behavior"],
            "allow"
        );
    }

    #[test]
    fn test_format_deny_response() {
        let parsed: serde_json::Value = serde_json::from_str(DENY_RESPONSE).unwrap();
        assert_eq!(
            parsed["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(parsed["hookSpecificOutput"]["decision"]["behavior"], "deny");
    }

    #[test]
    fn test_response_formats_are_valid_json() {
        // Verify both responses are parseable and have the exact expected structure
        let allow: serde_json::Value = serde_json::from_str(ALLOW_RESPONSE).unwrap();
        let deny: serde_json::Value = serde_json::from_str(DENY_RESPONSE).unwrap();

        // They should differ only in the behavior field
        assert_eq!(
            allow["hookSpecificOutput"]["hookEventName"],
            deny["hookSpecificOutput"]["hookEventName"]
        );
        assert_ne!(
            allow["hookSpecificOutput"]["decision"]["behavior"],
            deny["hookSpecificOutput"]["decision"]["behavior"]
        );
    }

    // ── Token auth ──────────────────────────────────────────────────────

    #[test]
    fn test_constant_time_eq_equal() {
        assert!(constant_time_eq(b"abc123", b"abc123"));
        assert!(constant_time_eq(b"", b""));
        assert!(constant_time_eq(
            b"4f3a8b00ab544e62a7e0e0e3aabbccdd",
            b"4f3a8b00ab544e62a7e0e0e3aabbccdd"
        ));
    }

    #[test]
    fn test_constant_time_eq_unequal_length() {
        // Differing length must fail without panicking on a slice OOB read.
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"abcd", b"abc"));
        assert!(!constant_time_eq(b"", b"x"));
    }

    #[test]
    fn test_constant_time_eq_unequal_content() {
        // Differs at first byte
        assert!(!constant_time_eq(b"Xbc", b"abc"));
        // Differs at last byte (would short-circuit with `==`; matters because
        // the production code has to be timing-resistant).
        assert!(!constant_time_eq(b"abcX", b"abcY"));
    }

    #[test]
    fn test_provision_token_shape() {
        // Token is a 32-char lowercase-hex string. We can't easily redirect
        // the file write target here without env-var injection, so just
        // verify the returned value's shape and that re-calling produces a
        // different token (CSPRNG / per-launch property). The atomic_write
        // side effect is covered indirectly by integration tests; the unit
        // tests below cover the read path with an explicit path.
        let a = uuid::Uuid::new_v4().simple().to_string();
        let b = uuid::Uuid::new_v4().simple().to_string();
        assert_eq!(a.len(), 32);
        assert_eq!(b.len(), 32);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_read_token_roundtrip() {
        // Write a token to a temp file, read it back, confirm match. Mirrors
        // what the Python hook will do: read the on-disk file, send the
        // string verbatim in the X-Cue-Token header.
        let dir = std::env::temp_dir().join("cue_test_token_roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("permission-token");
        let original = "deadbeefcafef00d0011223344556677";
        crate::security::atomic_write(&path, original.as_bytes()).unwrap();
        let read_back = read_token(&path).unwrap();
        assert_eq!(read_back, original);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_provision_secrets_writes_two_distinct_secrets() {
        // F-security-001: provisioning must write BOTH the req token and the
        // never-transmitted resp token, each 32 hex chars, and they must differ
        // (else echoing the request token back would authenticate a rogue).
        let dir = std::env::temp_dir().join(format!("cue_test_secrets_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let token_path = dir.join("permission-token");
        let proof_path = dir.join("permission-proof");

        let s = provision_secrets_at(&token_path, &proof_path).unwrap();
        assert_eq!(s.req_token.len(), 32);
        assert_eq!(s.resp_token.len(), 32);
        assert_ne!(
            s.req_token, s.resp_token,
            "the two secrets must be independent"
        );
        assert_eq!(read_token(&token_path).unwrap(), s.req_token);
        assert_eq!(read_token(&proof_path).unwrap(), s.resp_token);

        // remove_secrets_at deletes both and is safe to call twice.
        remove_secrets_at(&token_path, &proof_path);
        assert!(!token_path.exists());
        assert!(!proof_path.exists());
        remove_secrets_at(&token_path, &proof_path); // idempotent, no panic

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_proof_header_authenticates_server() {
        // The proof secret the hook compares against is the resp_token the
        // server returns in X-Cue-Proof. A value that doesn't match it (what a
        // rogue server — which only ever saw req_token — could at best echo)
        // must fail the constant-time check, so the hook rejects the decision.
        let dir = std::env::temp_dir().join(format!("cue_test_proof_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = provision_secrets_at(&dir.join("permission-token"), &dir.join("permission-proof"))
            .unwrap();

        // Real server proof matches; the request token (all a rogue holds) does not.
        assert!(constant_time_eq(
            s.resp_token.as_bytes(),
            s.resp_token.as_bytes()
        ));
        assert!(!constant_time_eq(
            s.req_token.as_bytes(),
            s.resp_token.as_bytes()
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
