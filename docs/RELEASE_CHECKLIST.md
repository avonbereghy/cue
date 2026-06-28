# Release checklist

This is the human gate for cutting a Cue release. CI already enforces
correctness, security, and supply-chain posture on every push and PR (see
[What CI already covers](#what-ci-already-covers)); this checklist covers only
the steps a workflow *cannot* do for you — version consistency, changelog,
tagging, and reviewing the draft release before it goes public.

Releases are cut from `main`. A `vX.Y.Z` tag push triggers
[`release.yml`](../.github/workflows/release.yml), which builds, signs the
auto-updater artifacts, and opens a **draft** GitHub Release for you to review
and publish manually.

## Before you tag

- [ ] **You're on `main` and it's up to date.** `release.yml` will build
      whatever commit the tag points at — make sure that's the commit you
      reviewed, not a stale branch. Tagging a commit that never landed on
      `main` ships code that was never gated by CI.
- [ ] **CI is green on the exact commit you're about to tag.** The release
      pipeline only builds and signs — it does **not** run the test suites.
      `ci.yml` is what proves the code is correct. Confirm the green check on
      that specific commit before tagging.
- [ ] **`make verify` passes locally.** This mirrors the CI gate (Rust
      fmt/clippy/test, frontend typecheck/build/test, Python hook tests) so you
      catch drift before pushing the tag. If it passes locally and CI is green,
      you're aligned.
- [ ] **Version is bumped and consistent across all three manifests.** The tag
      `vX.Y.Z` must match the version in:
  - [ ] `cue-desktop/package.json`
  - [ ] `cue-desktop/src-tauri/Cargo.toml`
  - [ ] `cue-desktop/src-tauri/tauri.conf.json`

      These are bumped by hand and nothing fails the build if they drift — a
      mismatched tag is the most common release footgun. Quick check:

      ```sh
      grep -E '"version":' cue-desktop/package.json cue-desktop/src-tauri/tauri.conf.json
      grep -E '^version *=' cue-desktop/src-tauri/Cargo.toml
      ```

- [ ] **`CHANGELOG.md` is updated.** Move the relevant notes out of
      `[Unreleased]` into a new `[X.Y.Z]` section with today's date. Cue follows
      [Keep a Changelog](https://keepachangelog.com/) and SemVer; being pre-1.0,
      a `0.x` minor bump may include breaking changes.

## Tag and push

- [ ] Create an **annotated** tag matching the manifests, then push it:

      ```sh
      git tag -a vX.Y.Z -m "Cue vX.Y.Z"
      git push origin vX.Y.Z
      ```

- [ ] The push triggers `release.yml`. It builds macOS (Apple Silicon + Intel),
      Windows, and Linux bundles, generates the Tauri auto-updater artifacts,
      and opens a **draft** release. This takes a while — multi-platform builds
      are not instant.

## Review the draft release

- [ ] **Open the draft** under GitHub → Releases and confirm bundles are
      attached for **all four targets**: macOS aarch64, macOS x86_64, Windows,
      Linux.
- [ ] **Confirm the updater manifest** (`latest.json`) is present. Existing
      installs pull the update from it on next launch, so a missing or wrong
      manifest silently breaks auto-update.
- [ ] **Confirm `SHA256SUMS` is attached.** A separate job hashes every bundle
      after upload. If it's missing, the checksums job failed — check the run
      logs before publishing.
- [ ] **Confirm build provenance attached** (SLSA Build L2 via Sigstore).
      Verify with:

      ```sh
      gh attestation verify <downloaded-asset> --repo avonbereghy/cue
      ```

- [ ] **Edit the release notes** if needed. The auto-generated body is generic;
      a short summary or a link to the changelog section is friendlier.
- [ ] **Publish the draft** once everything checks out. This is the only manual
      step that makes the release public and arms auto-update for users.

> [!NOTE]
> **First real release only.** The provenance attestation and `SHA256SUMS`
> jobs are untested until a tag is actually pushed — the bundle path globs may
> not match on the first run. On the very first release, explicitly verify both
> are attached and correct before publishing; fix the globs from the run logs
> if not. After one successful release this is a no-op.

> [!NOTE]
> **Binaries are unsigned** (except the Tauri updater artifacts, which are
> signed so auto-update stays trustworthy). End users will hit macOS Gatekeeper
> / Windows SmartScreen on first launch — see `README.md` / `cue-desktop/INSTALL.md` for
> the bypass steps. Build provenance is the trust signal that compensates for
> unsigned app binaries. Don't describe the binaries as "signed" anywhere.

## After publishing

- [ ] Verify the published release is no longer marked *Draft* and shows the
      correct tag.
- [ ] (Optional) Download one bundle and confirm it launches.
- [ ] Confirm the `[X.Y.Z]` changelog section is settled and start a fresh
      empty `[Unreleased]` section for the next cycle.

## What CI already covers

You do **not** need to run these by hand before a release — they run
automatically on every push and PR, and (where noted) on a weekly schedule.
This checklist assumes they're green; don't duplicate them here.

- **Correctness** — `ci.yml`: Rust fmt/clippy/test, frontend typecheck/build/
  test, Python hook tests. This is the merge gate. `make verify` mirrors it.
- **Dependency vulnerabilities** — `security-audit.yml`: `cargo audit` +
  `npm audit`, every push/PR and weekly. Runs even while the repo is private.
- **Static analysis** — `codeql.yml`: CodeQL over the TypeScript frontend
  (Rust is covered by clippy). Public repos only.
- **Vulnerable dependency introduction** — `dependency-review.yml`: blocks PRs
  that add high-severity-vulnerable deps. Public repos only.
- **Supply-chain posture** — `scorecard.yml`: OpenSSF Scorecard, informational.
  Public repos only.

> Some of the above (CodeQL, dependency-review, Scorecard) only run while the
> repository is public — they skip without failing while private. If Cue is
> still private, treat that coverage as dormant until it goes public.

---

## Maintainer-only: Bear & Eddy pass

> **External contributors and forks: ignore this section.** These are internal
> maintainer tools (Bear & Eddy) and are **not required** to cut a release —
> everything above stands on its own. If you don't have the tooling installed,
> skip straight past it.

These overlap with, but don't replace, CI. They're a fast local sanity pass the
maintainer can run before tagging:

- [ ] **Secret scan** — Sentinel `scan_secrets` over `cue-desktop/src`. A
      last-mile check that no token or key crept into the frontend before a
      public release.
- [ ] **Dependency audit** — Sentinel `audit_dependencies` for a quick read on
      outdated/risky frontend deps. (CI's `npm audit` is the authoritative gate;
      this is just a friendlier local summary.)

Scope is the TypeScript frontend only — Sentinel can't meaningfully lint the
Rust backend or the Python hook, and those are already covered by clippy and
pytest in CI.
