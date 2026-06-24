# Contributing to Cue

Thanks for your interest in improving Cue! Cue is a cross-platform desktop app
(Tauri v2 — Rust backend + React/TypeScript frontend) that monitors Claude Code
sessions. This guide covers building from source and the checks your change must
pass.

## Prerequisites

- **Rust** (stable) with `clippy` and `rustfmt` components
- **Node.js** 20+ and npm
- **Python 3** on your `PATH` — Cue's Claude Code hook is a Python 3 script,
  invoked as `<python3> cue-hook <state>` (no execute bit / shebang reliance, so
  the same hook works on macOS, Linux, and Windows)
- Platform toolchain for Tauri — see the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/)

## Project layout

```
cue-desktop/
  src/            React + TypeScript frontend
  src-tauri/      Rust backend (Tauri commands, JSONL parsing, session state)
hooks/
  cue-hook        Python 3 Claude Code hook (writes sessions.json)
  cue-statusline  Bash statusline bridge (captures rate-limit data)
```

## Build & run

```bash
cd cue-desktop
npm install
npm run tauri dev      # run the app in development
npm run tauri build    # produce a release bundle
```

A plain `cargo build` / `npm run tauri dev` does **not** code-sign — only the
maintainer's release pipeline signs artifacts, so building from source works
without any signing certificate.

## Checks your PR must pass

CI runs these on every push and pull request (`.github/workflows/ci.yml`).
Please run them locally first — they're the exact commands CI uses:

**Rust** (from `cue-desktop/src-tauri`):

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

**Frontend** (from `cue-desktop`):

```bash
npx tsc --noEmit
npm run build
```

All new Rust modules should carry unit tests, and file I/O must go through the
helpers in `src-tauri/src/security.rs` (`atomic_write`, `read_to_string_bounded`,
`sanitize_workspace_path`) — see the security notes in
`cue-desktop/.claude/CLAUDE.md`.

## Commit messages

Cue follows [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): description` (e.g. `fix(parser): handle empty JSONL line`). Types:
`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore`, `revert`. Keep the subject under 72 characters, imperative mood.

## Pull requests

1. Fork and branch from `main`.
2. Keep changes focused; describe the *why* in the PR body.
3. Make sure the checks above are green.
4. Link any issue the PR addresses.

## Reporting bugs & requesting features

Open an issue using the templates under
[`.github/ISSUE_TEMPLATE`](.github/ISSUE_TEMPLATE). For anything that looks like
a security issue, please use GitHub's **private vulnerability reporting**
(Security → Report a vulnerability) rather than a public issue.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
