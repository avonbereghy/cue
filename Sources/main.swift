import AppKit
import Foundation
import ServiceManagement
import SwiftUI

// MARK: - Data Models

struct SessionInfo: Codable {
    let id: String
    let workspace: String
    let state: String       // "working", "waiting", or "done"
    let lastActivity: Double
    let startedAt: Double
}

struct StatusData: Codable {
    var sessions: [String: SessionInfo]
}

// MARK: - App Delegate

// MARK: - Settings View

struct ClaudeStatusSettingsView: View {
    @AppStorage("showInDock") var showInDock = true
    @AppStorage("startAtLogin") var startAtLogin = false

    var body: some View {
        Form {
            Section {
                Toggle("Show icon in dock", isOn: $showInDock)
                    .onChange(of: showInDock) { _, newValue in
                        NSApp.setActivationPolicy(newValue ? .regular : .accessory)
                    }
                Toggle("Start at login", isOn: $startAtLogin)
                    .onChange(of: startAtLogin) { _, newValue in
                        do {
                            if newValue {
                                try SMAppService.mainApp.register()
                            } else {
                                try SMAppService.mainApp.unregister()
                            }
                        } catch {
                            startAtLogin = !newValue
                        }
                    }
            }
        }
        .formStyle(.grouped)
        .frame(width: 350)
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var pollTimer: Timer?
    private var animTimer: Timer?
    private var blinkOn = true
    private var sessions: [SessionInfo] = []
    private var settingsWindow: NSWindow?

    private let statusFilePath: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/Library/Application Support/ClaudeStatus/sessions.json"
    }()

    // Dot grid layout constants
    private let dotSize: CGFloat = 7.0
    private let hSpacing: CGFloat = 3.5
    private let vSpacing: CGFloat = 3.0
    private let padding: CGFloat = 2.0
    private let maxPerColumn = 2

    func applicationDidFinishLaunching(_ notification: Notification) {
        let showInDock = UserDefaults.standard.object(forKey: "showInDock") as? Bool ?? true
        NSApp.setActivationPolicy(showInDock ? .regular : .accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        // Dynamic menu via delegate
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        // Poll session status every second
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.pollStatus()
        }

        // Blink animation every 0.5s
        animTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.blinkOn.toggle()
            self?.updateIcon()
        }

        pollStatus()
    }

    // MARK: - Status Polling

    func pollStatus() {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: statusFilePath)),
              let status = try? JSONDecoder().decode(StatusData.self, from: data) else {
            sessions = []
            updateIcon()
            return
        }

        let now = Date().timeIntervalSince1970

        // State-dependent staleness: idle sessions expire fast (ghost cleanup),
        // active sessions persist much longer (only SessionEnd should remove them).
        sessions = status.sessions.values
            .filter { session in
                let age = now - session.lastActivity
                switch session.state {
                case "idle":   return age < 60    // 1 minute — catches ghost sessions
                default:       return age < 1800  // 30 minutes — covers quiet periods
                }
            }
            .sorted { $0.startedAt < $1.startedAt }

        // Cap at 8 (our grid maximum)
        if sessions.count > 8 {
            sessions = Array(sessions.prefix(8))
        }

        updateIcon()
    }

    // MARK: - Icon Rendering

    func updateIcon() {
        let image = renderDotGrid()
        statusItem.button?.image = image
    }

    func renderDotGrid() -> NSImage {
        let count = sessions.count

        // No sessions — hollow ring to indicate app is running but nothing active
        if count == 0 {
            let size = dotSize + padding * 2
            let image = NSImage(size: NSSize(width: size, height: size))
            image.lockFocus()
            NSColor.white.setStroke()
            let path = NSBezierPath(ovalIn: NSRect(x: padding + 0.75, y: padding + 0.75, width: dotSize - 1.5, height: dotSize - 1.5))
            path.lineWidth = 1.5
            path.stroke()
            image.unlockFocus()
            image.isTemplate = false
            return image
        }

        // Vertical stacking, columns grow right-to-left
        // First column (rightmost) fills bottom-to-top, then next column to the left
        let activeCols = Int(ceil(Double(count) / Double(maxPerColumn)))
        let activeRows = min(count, maxPerColumn)

        let width = CGFloat(activeCols) * dotSize + CGFloat(max(0, activeCols - 1)) * hSpacing + padding * 2
        let height = CGFloat(activeRows) * dotSize + CGFloat(max(0, activeRows - 1)) * vSpacing + padding * 2

        let image = NSImage(size: NSSize(width: width, height: height))
        image.lockFocus()

        for i in 0..<count {
            let col = i / maxPerColumn              // which column (0 = first filled)
            let row = i % maxPerColumn               // position within column
            // Rightmost column = col 0, grows left
            let x = padding + CGFloat(activeCols - 1 - col) * (dotSize + hSpacing)
            let y = padding + CGFloat(row) * (dotSize + vSpacing)  // bottom to top
            let rect = NSRect(x: x, y: y, width: dotSize, height: dotSize)

            let session = sessions[i]
            let color: NSColor
            switch session.state {
            case "working":
                color = blinkOn
                    ? NSColor.white
                    : NSColor.white.withAlphaComponent(0.15)
            case "waiting":
                color = NSColor.systemYellow
            case "idle":
                color = NSColor.white.withAlphaComponent(0.35)
            default:
                color = NSColor.systemGreen
            }

            color.setFill()
            NSBezierPath(ovalIn: rect).fill()
        }

        image.unlockFocus()
        image.isTemplate = false
        return image
    }
}

// MARK: - Menu Delegate

extension AppDelegate: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let header = NSMenuItem(title: "Claude Code Sessions", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(NSMenuItem.separator())

        if sessions.isEmpty {
            let item = NSMenuItem(title: "No active sessions", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        } else {
            for session in sessions {
                let name = URL(fileURLWithPath: session.workspace).lastPathComponent
                let icon: String
                switch session.state {
                case "working": icon = "⟳"
                case "waiting": icon = "⏸"
                case "idle": icon = "○"
                default: icon = "✓"
                }
                let elapsed = formatDuration(Date().timeIntervalSince1970 - session.startedAt)

                let item = NSMenuItem(
                    title: "\(icon)  \(name) — \(elapsed)",
                    action: nil,
                    keyEquivalent: ""
                )
                item.isEnabled = false
                menu.addItem(item)
            }
        }

        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Settings...", action: #selector(showSettings), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
    }

    @objc func showSettings() {
        if let window = settingsWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 350, height: 120),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Settings"
        window.contentView = NSHostingView(rootView: ClaudeStatusSettingsView())
        window.center()
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow = window
    }

    @objc func quit() {
        NSApplication.shared.terminate(nil)
    }

    private func formatDuration(_ seconds: TimeInterval) -> String {
        let totalSeconds = max(0, Int(seconds))
        let mins = totalSeconds / 60
        let secs = totalSeconds % 60
        return mins > 0 ? "\(mins)m \(secs)s" : "\(secs)s"
    }
}

// MARK: - Entry Point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
