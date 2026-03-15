import AppKit
import Foundation
import ServiceManagement
import SwiftUI

// MARK: - Settings View

struct CueSettingsView: View {
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

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var pollTimer: Timer?
    private var animTimer: Timer?
    private var metricsTimer: Timer?
    private var blinkOn = true
    private var settingsWindow: NSWindow?
    private var dashboardWindow: NSWindow?
    let monitor = SessionMonitor()

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
            self?.monitor.pollStatus()
            self?.updateIcon()
        }

        // Blink animation every 0.5s
        animTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.blinkOn.toggle()
            self?.updateIcon()
        }

        // Refresh JSONL metrics every 5s
        metricsTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.monitor.refreshMetrics()
        }

        monitor.pollStatus()
        monitor.refreshMetrics()

        // Auto-open dashboard on launch
        DispatchQueue.main.async { [weak self] in
            self?.showDashboard()
        }
    }

    // MARK: - Icon Rendering

    func updateIcon() {
        let image = renderDotGrid()
        statusItem.button?.image = image
    }

    func renderDotGrid() -> NSImage {
        let sessions = monitor.enrichedSessions
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
        let activeCols = Int(ceil(Double(count) / Double(maxPerColumn)))
        let activeRows = min(count, maxPerColumn)

        let width = CGFloat(activeCols) * dotSize + CGFloat(max(0, activeCols - 1)) * hSpacing + padding * 2
        let height = CGFloat(activeRows) * dotSize + CGFloat(max(0, activeRows - 1)) * vSpacing + padding * 2

        let image = NSImage(size: NSSize(width: width, height: height))
        image.lockFocus()

        for i in 0..<min(count, 8) {
            let col = i / maxPerColumn
            let row = i % maxPerColumn
            let x = padding + CGFloat(activeCols - 1 - col) * (dotSize + hSpacing)
            let y = padding + CGFloat(row) * (dotSize + vSpacing)
            let rect = NSRect(x: x, y: y, width: dotSize, height: dotSize)

            let state = sessions[i].info.state
            let color: NSColor
            switch state {
            case "working":
                color = blinkOn
                    ? NSColor.white
                    : NSColor.white.withAlphaComponent(0.15)
            case "waiting":
                color = NSColor.systemYellow
            case "error":
                color = NSColor.systemRed
            case "subagent":
                color = blinkOn
                    ? NSColor.systemCyan
                    : NSColor.systemCyan.withAlphaComponent(0.15)
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

    // MARK: - Windows

    @objc func showDashboard() {
        if let window = dashboardWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 500),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Claude Cue Dashboard"
        window.contentView = NSHostingView(rootView: DashboardView(monitor: monitor))
        window.center()
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("DashboardWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        dashboardWindow = window
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
        window.contentView = NSHostingView(rootView: CueSettingsView())
        window.center()
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow = window
    }

    @objc func quit() {
        NSApplication.shared.terminate(nil)
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

        let sessions = monitor.enrichedSessions
        if sessions.isEmpty {
            let item = NSMenuItem(title: "No active sessions", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        } else {
            for session in sessions {
                let name = session.workspaceName
                let icon = session.stateIcon
                let elapsed = Format.duration(session.duration)
                let tokens = session.metrics.totalTokens > 0
                    ? " · \(Format.tokens(session.metrics.totalTokens)) tokens"
                    : ""

                let item = NSMenuItem(
                    title: "\(icon)  \(name) — \(elapsed)\(tokens)",
                    action: nil,
                    keyEquivalent: ""
                )
                item.isEnabled = false
                menu.addItem(item)
            }
        }

        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Dashboard...", action: #selector(showDashboard), keyEquivalent: "d"))
        menu.addItem(NSMenuItem(title: "Settings...", action: #selector(showSettings), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
    }
}

// MARK: - Entry Point

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
