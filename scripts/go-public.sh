#!/usr/bin/env bash
#
# go-public.sh — one-time setup to run RIGHT AFTER flipping avonbereghy/cue to
# public. These features are gated to public repos on the GitHub Free plan, so
# they cannot be enabled while the repo is private:
#
#   - secret scanning + push protection
#   - private vulnerability reporting
#   - GitHub Discussions (used by SUPPORT.md / issue-template contact links)
#   - a branch ruleset on `main` (require CI, block force-push + deletion)
#
# Requires the `gh` CLI, authenticated as a repo admin. Re-running is mostly
# idempotent; the ruleset step errors if a ruleset of the same name already
# exists (harmless — delete it first or ignore).
set -uo pipefail

REPO="avonbereghy/cue"
echo "==> Target repo: $REPO"

vis=$(gh repo view "$REPO" --json visibility -q .visibility 2>/dev/null || echo "UNKNOWN")
if [ "$vis" != "PUBLIC" ]; then
  echo "!! Repo is currently '$vis'. Make it public first" >&2
  echo "   (Settings → General → Danger Zone → Change visibility), then re-run." >&2
  exit 1
fi

echo "==> Enabling secret scanning + push protection"
gh api -X PATCH "repos/$REPO" --input - >/dev/null <<'JSON' && echo "   ok" || echo "   (skipped/failed — check manually)"
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
} }
JSON

echo "==> Enabling private vulnerability reporting"
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null && echo "   ok" || echo "   (already enabled or failed — check manually)"

echo "==> Enabling Discussions"
gh api -X PATCH "repos/$REPO" -F has_discussions=true >/dev/null && echo "   ok" || echo "   (skipped/failed — check manually)"

echo "==> Creating branch ruleset on default branch (require CI, block force-push + deletion)"
gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<'JSON' && echo "   ok" || echo "   (a ruleset may already exist — check Settings → Rules)"
{
  "name": "main protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "rust" },
          { "context": "frontend" }
        ]
      }
    }
  ]
}
JSON

echo
echo "==> Done. Verify under Settings → Security and Settings → Rules."
echo "    Scorecard / CodeQL / Dependency-Review workflows will start running"
echo "    automatically now that the repo is public (they self-skip while private)."
