#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/hooks/claude-status-hook"
STATUS_DIR="$HOME/Library/Application Support/ClaudeStatus"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
APP_NAME="Claude Status Bar.app"
APP_DIR="/Applications/Utilities"
APP_PATH="$APP_DIR/$APP_NAME"

echo "=== Claude Status Bar Installer ==="
echo ""

# 1. Create status directory with empty sessions file
mkdir -p "$STATUS_DIR"
if [ ! -f "$STATUS_DIR/sessions.json" ]; then
    echo '{"sessions":{}}' > "$STATUS_DIR/sessions.json"
fi
echo "✓ Status directory ready"

# 2. Ensure hook script is executable
chmod +x "$HOOK_SCRIPT"
echo "✓ Hook script ready"

# 3. Build the binary
echo ""
echo "Building..."
cd "$SCRIPT_DIR"
swift build -c release 2>&1 | tail -3
BINARY="$(swift build -c release --show-bin-path)/ClaudeStatusBar"
echo "✓ Binary built"

# 4. Kill existing instance if running
pkill -f "Claude Status Bar.app/Contents/MacOS/ClaudeStatusBar" 2>/dev/null || true

# 5. Create .app bundle
mkdir -p "$APP_DIR"
rm -rf "$APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS"
mkdir -p "$APP_PATH/Contents/Resources"

# Copy binary into bundle
cp "$BINARY" "$APP_PATH/Contents/MacOS/ClaudeStatusBar"

# Generate app icon
echo "Generating icon..."
ICON_PNG="/tmp/claude-status-icon-1024.png"
swift "$SCRIPT_DIR/generate-icon.swift" "$ICON_PNG"

# Create .iconset with all required sizes
ICONSET="/tmp/ClaudeStatusBar.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for sz in 16 32 128 256 512; do
    sips -z $sz $sz "$ICON_PNG" --out "$ICONSET/icon_${sz}x${sz}.png" > /dev/null 2>&1
    double=$((sz * 2))
    sips -z $double $double "$ICON_PNG" --out "$ICONSET/icon_${sz}x${sz}@2x.png" > /dev/null 2>&1
done

# Convert to .icns
iconutil -c icns "$ICONSET" -o "$APP_PATH/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET" "$ICON_PNG"
echo "✓ Icon generated"

# Info.plist — LSUIElement makes it menu-bar-only (no dock icon while running)
cat > "$APP_PATH/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>ClaudeStatusBar</string>
    <key>CFBundleIdentifier</key>
    <string>com.claude-status-bar</string>
    <key>CFBundleName</key>
    <string>Claude Status Bar</string>
    <key>CFBundleDisplayName</key>
    <string>Claude Status Bar</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
</dict>
</plist>
PLIST

echo "✓ App bundle created at $APP_PATH"

# 6. Configure Claude Code hooks
echo ""
echo "Configuring Claude Code hooks..."

python3 << PYEOF
import json, os, sys

settings_path = os.path.expanduser("$CLAUDE_SETTINGS")
hook_script = "$HOOK_SCRIPT"

try:
    with open(settings_path, "r") as f:
        settings = json.load(f)
except Exception:
    settings = {}

if "hooks" not in settings:
    settings["hooks"] = {}

hooks = settings["hooks"]

new_hooks = {
    "SessionStart": {
        "matcher": "",
        "hooks": [{"type": "command", "command": f"{hook_script} idle", "timeout": 5000}]
    },
    "PreToolUse": {
        "matcher": "",
        "hooks": [{"type": "command", "command": f"{hook_script} working", "timeout": 5000}]
    },
    "PostToolUse": {
        "matcher": "",
        "hooks": [{"type": "command", "command": f"{hook_script} working", "timeout": 5000}]
    },
    "PermissionRequest": {
        "matcher": "",
        "hooks": [{"type": "command", "command": f"{hook_script} waiting", "timeout": 5000}]
    },
    "Stop": {
        "matcher": "",
        "hooks": [{"type": "command", "command": f"{hook_script} done", "timeout": 5000}]
    },
    "Notification": {
        "matcher": "",
        "hooks": [{"type": "command", "command": f"{hook_script} done", "timeout": 5000}]
    },
    "SessionEnd": {
        "matcher": "",
        "hooks": [{"type": "command", "command": f"{hook_script} remove", "timeout": 5000}]
    }
}

changed = False
for event_name, new_entry in new_hooks.items():
    if event_name not in hooks:
        hooks[event_name] = []

    already_exists = any(
        any(h.get("command", "").startswith(hook_script) for h in entry.get("hooks", []))
        for entry in hooks[event_name]
    )

    if not already_exists:
        hooks[event_name].append(new_entry)
        changed = True

if changed:
    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    if os.path.exists(settings_path):
        import shutil
        shutil.copy2(settings_path, settings_path + ".backup")
        print("  Backed up existing settings to settings.json.backup")

    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=2)
    print("✓ Hooks configured in ~/.claude/settings.json")
else:
    print("✓ Hooks already configured")
PYEOF

# 7. Launch the app
echo ""
echo "Launching..."
open "$APP_PATH"
echo "✓ Running!"

echo ""
echo "=== Installation complete ==="
echo ""
echo "App installed to: $APP_PATH"
echo "You can drag it to your Dock for easy access."
echo ""
echo "  ● Blinking white = Claude is working"
echo "  ● Yellow = waiting for your permission"
echo "  ● Green = done"
echo ""
echo "To start on login: System Settings → General → Login Items → add 'Claude Status Bar'"
echo ""
echo "To uninstall:"
echo "  rm -rf \"$APP_PATH\""
