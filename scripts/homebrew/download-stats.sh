#!/usr/bin/env bash
#
# download-stats.sh — report GitHub release download counts for Cue.
#
# WHY THIS EXISTS: Homebrew does NOT provide install analytics for third-party
# taps. Only the official homebrew/core and homebrew/cask repositories report
# install events to formulae.brew.sh. A personal tap like avonbereghy/homebrew-cue
# gets nothing from that pipeline.
#
# What it CAN measure: every `brew install --cask avonbereghy/cue/cue` downloads
# the macOS .dmg straight from this repo's GitHub releases, and GitHub counts
# each asset download. So the macOS .dmg counts are the best available proxy for
# Homebrew-cask installs (plus anyone who grabbed the .dmg directly — GitHub
# cannot tell the two apart).
#
# Requires: gh (authenticated), jq.
set -euo pipefail

REPO="${CUE_REPO:-avonbereghy/cue}"

command -v gh >/dev/null || { echo "error: gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }

echo "==> Cue download stats — $REPO (published releases)"
echo

# per_page=100 is plenty; avoids --paginate, which emits one JSON array per page
# and would break the single-input jq program below.
gh api "repos/$REPO/releases?per_page=100" \
  | jq -r '
      [ .[] | select(.draft | not) | {
          tag:   .tag_name,
          macos: ([ .assets[] | select(.name | test("\\.dmg$"))  | .download_count ] | add // 0),
          dmg_arm:   ([ .assets[] | select(.name | test("aarch64\\.dmg$")) | .download_count ] | add // 0),
          dmg_intel: ([ .assets[] | select(.name | test("x64\\.dmg$"))     | .download_count ] | add // 0),
          total: ([ .assets[] | .download_count ] | add // 0)
      } ] as $rel
      | ($rel[] | "\(.tag)\t\(.dmg_arm)\t\(.dmg_intel)\t\(.macos)\t\(.total)"),
        "TOTAL\t\($rel | map(.dmg_arm) | add // 0)\t\($rel | map(.dmg_intel) | add // 0)\t\($rel | map(.macos) | add // 0)\t\($rel | map(.total) | add // 0)"
    ' \
  | awk -F'\t' '
      BEGIN { printf "%-12s %10s %10s %12s %12s\n", "RELEASE", "dmg arm64", "dmg intel", "macOS total", "all assets" }
      $1=="TOTAL" { printf "%-12s %10s %10s %12s %12s\n", "", "", "", "", ""  }
      { printf "%-12s %10s %10s %12s %12s\n", $1, $2, $3, $4, $5 }
    '

echo
echo "macOS total .dmg downloads ≈ Homebrew-cask installs + direct .dmg downloads"
echo "(GitHub cannot distinguish them). Third-party taps get no formulae.brew.sh"
echo "analytics, so this is the popularity signal to track over time."
