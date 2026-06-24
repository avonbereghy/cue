# Security Policy

## Supported versions

Cue is pre-1.0 and ships from a single active release line. Security fixes land
on the latest release; older versions are not maintained.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

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

- **reads local files only** — Claude Code session data (`sessions.json`,
  `.jsonl` transcripts) and `settings.json`. It makes **no outbound network
  calls** and consumes **no Claude API usage**;
- runs a **localhost-only** HTTP server (`127.0.0.1:3002`) for the
  permission-approval hook — it is not reachable from off the machine;
- installs a hook script into `~/.claude/` and registers it in
  `~/.claude/settings.json` (your original settings are backed up once to
  `settings.json.bak`).

Existing hardening: atomic file writes, `0600` permissions on data files,
path-traversal sanitization, bounded file reads, and rejection of shell
metacharacters in hook paths.
