# Security Policy

## Supported versions

Cue is pre-1.0 and ships from a single active release line. Security fixes land
on the latest release; older versions are not maintained.

| Version | Supported          |
| ------- | ------------------ |
| 0.5.x   | :white_check_mark: |
| < 0.5   | :x:                |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately using GitHub's **"Report a vulnerability"** button on the
[Security Advisories page](https://github.com/avonbereghy/cue/security/advisories/new).
This opens a private advisory visible only to you and the maintainer.

Please include: the affected version, your platform/OS, steps to reproduce, and
the impact you observed.

You can expect an acknowledgment within **about 3 business days**. Once a fix is
ready we'll coordinate a release alongside a published advisory (and request a
CVE if warranted). We follow coordinated disclosure — please give a reasonable
window before any public write-up.

## Cue's attack surface

Cue is a local desktop app with a deliberately small surface. It:

- **reads provider-local files** — shared `sessions.json`, Claude conversation
  JSONL, and Codex rollout JSONL. Transcript paths are canonicalized and must
  remain under the owning provider's config root;
- runs a **localhost-only** HTTP server (`127.0.0.1:3002`) for the
  permission-approval hook — it is not reachable from off the machine;
- installs provider-specific copies of the shared writer only after explicit
  opt-in: `~/.claude/hooks/cue-hook` plus `~/.claude/settings.json`, and/or
  `$CODEX_HOME/hooks/cue-hook` plus `$CODEX_HOME/hooks.json`. Merge and uninstall
  operations touch only Cue-owned hook commands and preserve unrelated entries;
- does not bypass Codex hook trust. Users must run `/hooks` in a trusted Codex
  project and explicitly trust/enable Cue's commands.

Existing hardening: atomic file writes, `0600` permissions on data files,
path-traversal sanitization, bounded file reads, and rejection of shell
metacharacters in hook paths. Internal state uses provider-qualified keys
(`claude:<id>` / `codex:<id>`) so equal native IDs cannot cross-wire permission,
notification, cache, dismissal, or resume actions. The localhost permission
channel authenticates requests and responses with a per-launch HMAC secret and
fails closed to the provider's native prompt.
