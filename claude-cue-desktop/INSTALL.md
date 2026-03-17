# Installing Claude Cue

Claude Cue is a cross-platform desktop app that monitors your Claude Code sessions and shows their status in the system tray. Pre-built installers are available for Windows and Linux from the [Releases](https://github.com/your-org/ClaudeStage/releases) page.

## Prerequisites

- **Python 3** (3.9 or later) — required for the session-monitoring hook script
- **Claude Code** — the CLI tool whose sessions Claude Cue monitors

## macOS

### Build from source

```bash
cd claude-cue-desktop
npm install
npm run tauri build
```

Then copy the app to your Applications folder:

```bash
cp -R src-tauri/target/release/bundle/macos/Claude\ Cue.app ~/Applications/
open ~/Applications/Claude\ Cue.app
```

The onboarding wizard configures the Claude Code hooks automatically on first launch.

To start on login: **System Settings > General > Login Items > add "Claude Cue"**

### Uninstall

```bash
rm -rf ~/Applications/Claude\ Cue.app
```

Then remove the hook entries from `~/.claude/settings.json` (search for `cue-hook`).

## Windows

### MSI installer (recommended)

1. Download `Claude-Cue_x.y.z_x64_en-US.msi` from the latest release.
2. Double-click the `.msi` to run the installer.
3. Follow the on-screen prompts. The app installs per-user by default (no admin required).
4. Launch **Claude Cue** from the Start Menu.
5. The onboarding wizard will guide you through configuring the Claude Code hook.

### NSIS installer (alternative)

1. Download `Claude-Cue_x.y.z_x64-setup.exe` from the latest release.
2. Run the installer and follow the prompts.
3. Launch **Claude Cue** from the Start Menu.

## Linux

### AppImage

1. Download `claude-cue_x.y.z_amd64.AppImage` from the latest release.
2. Make it executable:
   ```bash
   chmod +x claude-cue_x.y.z_amd64.AppImage
   ```
3. Run it:
   ```bash
   ./claude-cue_x.y.z_amd64.AppImage
   ```

**Note for GNOME users:** The system tray icon requires the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/). Install it via:
```bash
sudo apt install gnome-shell-extension-appindicator
```
Then log out and back in, and enable the extension in GNOME Extensions.

### .deb package (Debian/Ubuntu)

1. Download `claude-cue_x.y.z_amd64.deb` from the latest release.
2. Install with dpkg:
   ```bash
   sudo dpkg -i claude-cue_x.y.z_amd64.deb
   sudo apt-get install -f   # resolve dependencies if needed
   ```
   The package declares `libwebkit2gtk-4.1-0` as a dependency, which `apt` will pull in automatically.
3. Launch **Claude Cue** from your application menu, or run `claude-cue` from the terminal.

## Post-install setup

On first launch, Claude Cue presents an onboarding wizard that:

1. Detects your Claude Code installation
2. Installs the session-monitoring hook into Claude Code's hook directory
3. Verifies the hook is working by checking for session data

No manual configuration is needed. The hook runs automatically whenever Claude Code starts or updates a session.

## Uninstall

### Windows

- **MSI:** Settings > Apps > Claude Cue > Uninstall, or run `msiexec /x {product-code}`
- **NSIS:** Settings > Apps > Claude Cue > Uninstall

### Linux

- **AppImage:** Delete the `.AppImage` file. Optionally remove `~/.config/com.claudecue.desktop/` for settings.
- **.deb:** `sudo apt remove claude-cue`

### Hook cleanup

The Claude Code hook file is located at:
- Linux: `~/.claude/hooks/cue-hook`
- Windows: `%USERPROFILE%\.claude\hooks\cue-hook`

You can safely delete this directory after uninstalling Claude Cue. Claude Code will continue to work normally without the hook.
