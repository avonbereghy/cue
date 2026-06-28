#!/usr/bin/env bash
#
# render-cask.sh — emit the Homebrew cask for Cue.
#
# This is the single source of truth for Casks/cue.rb in the avonbereghy/homebrew-cue
# tap. Both the manual workflow and the `update-homebrew-tap` GitHub Action call it so
# the committed cask is always generated, never hand-edited (which keeps the two
# per-arch sha256 values impossible to mix up).
#
# Usage:
#   render-cask.sh <version> <arm64_dmg_sha256> <x64_dmg_sha256> [output_path]
#
# With no output_path it prints to stdout. Example:
#   render-cask.sh 0.5.3 a96691... 67d971... ../homebrew-cue/Casks/cue.rb
set -euo pipefail

VERSION="${1:?version required (e.g. 0.5.3, no leading v)}"
ARM_SHA="${2:?arm64 .dmg sha256 required}"
X64_SHA="${3:?x64 .dmg sha256 required}"
OUT="${4:-/dev/stdout}"

# Note: #{version}, #{arch}, #{appdir} below are Ruby/cask interpolations and must
# survive into the output verbatim. The heredoc is unquoted so only $-prefixed shell
# vars expand; #{...} has no $ and stays literal.
cat > "$OUT" <<EOF
cask "cue" do
  arch arm: "aarch64", intel: "x64"

  version "${VERSION}"
  sha256 arm:   "${ARM_SHA}",
         intel: "${X64_SHA}"

  url "https://github.com/avonbereghy/cue/releases/download/v#{version}/Cue_#{version}_#{arch}.dmg"
  name "Cue"
  desc "Real-time menu-bar monitor for Claude Code sessions"
  homepage "https://github.com/avonbereghy/cue"

  # Cue updates itself in place via the Tauri updater, so Homebrew should not try
  # to manage upgrades; it only delivers the initial install.
  auto_updates true
  depends_on macos: :sonoma

  app "Cue.app"

  zap trash: [
    "~/Library/Application Support/com.cueapp.desktop",
    "~/Library/Caches/com.cueapp.desktop",
    "~/Library/HTTPStorages/com.cueapp.desktop",
    "~/Library/Preferences/com.cueapp.desktop.plist",
    "~/Library/Saved Application State/com.cueapp.desktop.savedState",
    "~/Library/WebKit/com.cueapp.desktop",
  ]

  caveats <<~CAVEATS
    Cue is a free, open-source app and is not signed with an Apple Developer ID,
    so macOS Gatekeeper blocks it on first launch. Clear the quarantine flag once:

      xattr -dr com.apple.quarantine "#{appdir}/Cue.app"

    On first launch Cue's onboarding wizard installs its Claude Code hook into
    ~/.claude (a backup of your settings is kept). It then keeps itself up to
    date automatically.
  CAVEATS
end
EOF
