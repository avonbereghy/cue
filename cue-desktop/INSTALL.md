# Installing Cue

Cue is a cross-platform desktop app that monitors Claude Code and Codex sessions together and shows their status in the system tray. Pre-built installers are available for Windows and Linux from the [Releases](https://github.com/avonbereghy/cue/releases) page.

## Prerequisites

- **Python 3** (3.9 or later) — required for the session-monitoring hook script
- **Claude Code and/or Codex** — each integration is independently opt-in

## macOS

### DMG installer (recommended)

1. Download `Cue_x.y.z_universal.dmg` from the latest release.
2. Open the DMG and drag **Cue** into your Applications folder.
3. Launch from Applications. Cue's release builds are **not signed with an Apple Developer ID** (it's a free, personal open-source project), so macOS Gatekeeper warns on first launch. Do any one of the following, once:
   - **Right-click** (or Control-click) **Cue** in Finder → **Open** → **Open**; or
   - open **System Settings → Privacy & Security**, find the "Cue was blocked" message, and click **Open Anyway**; or
   - run `xattr -dr com.apple.quarantine /Applications/Cue.app`.

   In-app auto-update (the Tauri updater) still works — it uses its own signing key, independent of Apple notarization.

### Build from source

```bash
cd cue-desktop
npm install
npm run tauri build
```

Then copy the app to your Applications folder:

```bash
cp -R src-tauri/target/release/bundle/macos/Cue.app ~/Applications/
open ~/Applications/Cue.app
```

Local builds are ad-hoc-signed. macOS will show a Gatekeeper warning on first launch — right-click the app and choose **Open**, or run `xattr -dr com.apple.quarantine ~/Applications/Cue.app`.

The onboarding wizard offers independent Claude Code and Codex hook setup on first launch. Open Codex root sessions are discovered from `$CODEX_HOME/sessions` and its thread-writer locks even when the client was already running; hooks add precise event states. Restart Codex after installing or changing its hooks, then review/trust Cue with `/hooks`.

To start on login: **System Settings > General > Login Items > add "Cue"**

### Uninstall

```bash
rm -rf ~/Applications/Cue.app
```

Then remove Cue's hook entries from `~/.claude/settings.json` and/or `$CODEX_HOME/hooks.json` (search for `cue-hook`).

## Windows

### MSI installer (recommended)

1. Download `Cue_x.y.z_x64_en-US.msi` from the latest release.
2. Double-click the `.msi` to run the installer.
3. Follow the on-screen prompts. The app installs per-user by default (no admin required).
4. Launch **Cue** from the Start Menu.
5. The onboarding wizard will guide you through configuring either provider's hooks.

### NSIS installer (alternative)

1. Download `Cue_x.y.z_x64-setup.exe` from the latest release.
2. Run the installer and follow the prompts.
3. Launch **Cue** from the Start Menu.

> **Unsigned installer.** Cue's Windows builds are not code-signed, so SmartScreen may show "Windows protected your PC." Click **More info → Run anyway** to proceed.

## Linux

### AppImage

1. Download `cue_x.y.z_amd64.AppImage` from the latest release.
2. Make it executable:
   ```bash
   chmod +x cue_x.y.z_amd64.AppImage
   ```
3. Run it:
   ```bash
   ./cue_x.y.z_amd64.AppImage
   ```

**Note for GNOME users:** The system tray icon requires the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/). Install it via:
```bash
sudo apt install gnome-shell-extension-appindicator
```
Then log out and back in, and enable the extension in GNOME Extensions.

### .deb package (Debian/Ubuntu)

1. Download `cue_x.y.z_amd64.deb` from the latest release.
2. Install with dpkg:
   ```bash
   sudo dpkg -i cue_x.y.z_amd64.deb
   sudo apt-get install -f   # resolve dependencies if needed
   ```
   The package declares `libwebkit2gtk-4.1-0` as a dependency, which `apt` will pull in automatically.
3. Launch **Cue** from your application menu, or run `cue` from the terminal.

## Post-install setup

On first launch, Cue presents an onboarding wizard that detects both harnesses and lets you enable either one without modifying the other:

1. Detects Claude Code, Codex, and Python 3.
2. For Claude Code, copies `cue-hook` to `~/.claude/hooks/cue-hook` and merges Cue's events into `~/.claude/settings.json`.
3. For Codex, copies the same writer to `$CODEX_HOME/hooks/cue-hook` (normally `~/.codex/hooks/cue-hook`) and merges supported events into `$CODEX_HOME/hooks.json` using `--harness codex`.
4. Makes a one-time `.bak` copy of an existing provider config. Reinstall is idempotent and preserves every unrelated setting and hook.

Cue discovers already-open Codex root sessions independently from Codex rollout files and thread-writer locks. After enabling or changing hooks in Cue, restart the Codex client, open a trusted project, and run `/hooks`, then explicitly enable/trust Cue's command hooks. This is a required Codex trust boundary; Cue does not use the dangerous trust-bypass flag. Codex timeouts are configured in **seconds**, whereas Claude Code hook timeouts are **milliseconds**.

The hook is run through the Python interpreter rather than executed directly, so
it needs no execute bit and the exact same mechanism works on macOS, Linux, and
Windows. No manual editing is required, and the install does not depend on any
pre-existing files outside the app bundle. You can re-run it any time from
the provider-specific **Settings → Hooks → Reinstall** control.

If Python 3 is not on your `PATH`, setup fails with a clear message — install
Python 3 and click **Configure Hooks** again.

## Uninstall

### Windows

- **MSI:** Settings > Apps > Cue > Uninstall, or run `msiexec /x {product-code}`
- **NSIS:** Settings > Apps > Cue > Uninstall

### Linux

- **AppImage:** Delete the `.AppImage` file. Optionally remove `~/.config/com.cueapp.desktop/` for settings.
- **.deb:** `sudo apt remove cue`

### Hook cleanup

Cue's provider-specific hook files are located at:

- Claude Code: `~/.claude/hooks/cue-hook` (Windows: `%USERPROFILE%\.claude\hooks\cue-hook`)
- Codex: `$CODEX_HOME/hooks/cue-hook` (normally `~/.codex/hooks/cue-hook`; Windows: `%USERPROFILE%\.codex\hooks\cue-hook`)

Prefer Cue's independent Uninstall buttons, which surgically remove only Cue-owned entries. Both providers continue to work normally without Cue's hooks.
