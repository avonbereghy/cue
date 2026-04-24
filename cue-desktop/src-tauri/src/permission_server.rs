//! Localhost HTTP server for Claude Code PermissionRequest hooks.
//!
//! Listens on 127.0.0.1:{port} for POST /permission-request from Claude Code.
//! Holds the HTTP connection open until the user approves/denies via the dashboard.
//! GET /health returns 200 for testing.
//!
//! Wave 1: defines PendingRequests and response formatting.
//! Wave 2: wires the TCP listener and integrates with lib.rs.

use crate::models::PermissionDecision;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

/// Pending permission requests awaiting user decision.
pub struct PendingRequests {
    requests: Mutex<HashMap<String, oneshot::Sender<PermissionDecision>>>,
}

impl PendingRequests {
    pub fn new() -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
        }
    }

    /// Store a pending request and return a receiver for the decision.
    pub fn insert(&self, request_id: &str) -> oneshot::Receiver<PermissionDecision> {
        let (tx, rx) = oneshot::channel();
        self.requests
            .lock()
            .unwrap()
            .insert(request_id.to_string(), tx);
        rx
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
pub const ALLOW_RESPONSE: &str =
    r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#;

/// HTTP JSON response body for a Deny decision.
pub const DENY_RESPONSE: &str =
    r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}"#;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_insert_and_resolve_allow() {
        let pending = PendingRequests::new();
        let rx = pending.insert("req-1");

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
        let rx = pending.insert("req-2");

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

        let _rx = pending.insert("req-x");
        assert!(pending.is_pending("req-x"));
    }

    #[test]
    fn test_remove() {
        let pending = PendingRequests::new();
        let _rx = pending.insert("req-r");
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
        let _rx1 = pending.insert("a");
        let _rx2 = pending.insert("b");
        let _rx3 = pending.insert("c");

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
        assert_eq!(parsed["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
        assert_eq!(parsed["hookSpecificOutput"]["decision"]["behavior"], "allow");
    }

    #[test]
    fn test_format_deny_response() {
        let parsed: serde_json::Value = serde_json::from_str(DENY_RESPONSE).unwrap();
        assert_eq!(parsed["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
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
}
