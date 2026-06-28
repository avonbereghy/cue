# Cue — local convenience runner.
#
# These targets mirror .github/workflows/ci.yml (same commands, same working
# directories) so "green locally" means "green in CI". ci.yml remains the
# source of truth; if the two ever drift, fix the Makefile to match ci.yml.
#
# Requirements: a Rust toolchain (cargo, with clippy + rustfmt), Node 20 + npm,
# and Python 3.11 (with the `venv` module). No other dependencies — `make test`
# and `make verify` run on a vanilla clone. The hook suite installs pytest into
# a local .venv because Homebrew/Debian system Python is externally-managed
# (PEP 668) and refuses a bare `pip install`; CI gets away with a direct install
# only because it runs on an ephemeral, non-managed runner Python.

.DEFAULT_GOAL := help

.PHONY: help test test-rust test-frontend test-hooks verify lint

help: ## Show this help
	@echo "Cue make targets (mirror .github/workflows/ci.yml):"
	@echo "  make test           Run all three test suites (rust + frontend + hooks)"
	@echo "  make test-rust      Run the Rust suite (cargo test)"
	@echo "  make test-frontend  Run the frontend suite (vitest)"
	@echo "  make test-hooks     Run the Python hook suite (pytest, in a local .venv)"
	@echo "  make lint           Static checks only (fmt --check, clippy, tsc --noEmit)"
	@echo "  make verify         Full CI gate: lint + build + all test suites"

# --- Test suites (one per CI job) ------------------------------------------

test: test-rust test-frontend test-hooks ## Run all three test suites

test-rust: ## Rust unit tests (ci.yml: rust job)
	cd cue-desktop/src-tauri && cargo test

test-frontend: ## Frontend unit tests (ci.yml: frontend job)
	cd cue-desktop && npm test

test-hooks: ## Python hook tests (ci.yml: hooks job) — isolated .venv (PEP 668)
	@python3 -m venv .venv
	@.venv/bin/python -m pip install -q --disable-pip-version-check -r tests/hooks/requirements.txt
	.venv/bin/python -m pytest tests/hooks -q

# --- Static checks ----------------------------------------------------------

lint: ## fmt --check + clippy (warnings as errors) + tsc --noEmit
	cd cue-desktop/src-tauri && cargo fmt --check
	cd cue-desktop/src-tauri && cargo clippy --all-targets -- -D warnings
	cd cue-desktop && npx tsc --noEmit

# --- Full CI gate -----------------------------------------------------------

# Reproduces every gating step in ci.yml, in order, across all three jobs.
verify: ## Full CI gate: fmt + clippy + tsc + build + all tests
	cd cue-desktop/src-tauri && cargo fmt --check
	cd cue-desktop/src-tauri && cargo clippy --all-targets -- -D warnings
	cd cue-desktop/src-tauri && cargo test
	cd cue-desktop && npm ci
	cd cue-desktop && npx tsc --noEmit
	cd cue-desktop && npm run build
	cd cue-desktop && npm test
	@python3 -m venv .venv
	@.venv/bin/python -m pip install -q --disable-pip-version-check -r tests/hooks/requirements.txt
	.venv/bin/python -m pytest tests/hooks -q
