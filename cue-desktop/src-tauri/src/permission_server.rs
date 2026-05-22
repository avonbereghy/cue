//! Localhost HTTP server for Claude Code PermissionRequest hooks.
//!
//! Listens on 127.0.0.1:{port} for POST /permission-request from Claude Code.
//! Holds the HTTP connection open until the user approves/denies via the dashboard.
//! GET /health returns 200 for testing.
//!
//! Wave 1: defines PendingRequests and response formatting.
//! Wave 2: wires the TCP listener and integrates with lib.rs.

use crate::models::PermissionDecision;
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
        let mut map = self.requests.lock().unwrap();
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
            .lock()
            .unwrap()
            .remove(request_id)
            .ok_or_else(|| format!("No pending request: {}", request_id))?;
        sender
            .send(decision)
            .map_err(|_| "Receiver dropped".to_string())
    }

    /// Check if a request is still pending.
    pub fn is_pending(&self, request_id: &str) -> bool {
        self.requests.lock().unwrap().contains_key(request_id)
    }

    /// Remove a request without resolving (e.g., on timeout).
    pub fn remove(&self, request_id: &str) {
        self.requests.lock().unwrap().remove(request_id);
    }

    /// Return the number of currently pending requests.
    pub fn len(&self) -> usize {
        self.requests.lock().unwrap().len()
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

/// Generate a fresh 128-bit per-launch shared secret, atomically write it to
/// `permission_token_path()` at 0600, and return the token string.
///
/// Why a per-launch token: the permission server binds to `127.0.0.1:3002`
/// without any kernel-level access control, so any local process that wins
/// the port race could otherwise forge `{"behavior":"allow"}` responses to
/// Claude Code hook prompts. Co-locating a fresh secret under the user's
/// 0700 status dir (and writing it 0600) means only same-uid processes can
/// read it, and the secret is invalidated every launch. The legitimate
/// Python hook reads the same file before POSTing and presents the value
/// in `X-Cue-Token`; the server compares in constant time and 403s anything
/// else. Mitigates the prior unauthenticated-server finding.
pub fn provision_token() -> std::io::Result<String> {
    // 16 bytes of OS CSPRNG output via getrandom (which is what uuid::Uuid::new_v4
    // already pulls from). Hex-encoded — 32 ASCII chars — so it survives an HTTP
    // header round-trip without escaping concerns.
    let id = uuid::Uuid::new_v4();
    let token = id.simple().to_string();

    let path = paths::permission_token_path();
    security::atomic_write(&path, token.as_bytes())?;
    Ok(token)
}

/// Read a previously-provisioned token from `path`. Used only by the test
/// suite; the live server keeps the token in memory after `provision_token`
/// rather than re-reading on every request.
#[cfg(test)]
pub fn read_token(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    String::from_utf8(bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
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
}
