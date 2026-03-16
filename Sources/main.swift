import AppKit
import Foundation
import ServiceManagement
import SwiftUI

// MARK: - Settings View

// MARK: - Plan Presets

enum PlanPreset: String, CaseIterable {
    case custom = "Custom"
    case pro = "Pro ($20/mo)"
    case maxStandard = "Max ($100/mo)"
    case maxPlus = "Max ($200/mo)"

    var limits: (fiveHour: Int, daily: Int, weekly: Int) {
        switch self {
        case .custom:       return (0, 0, 0)
        case .pro:          return (500_000, 2_000_000, 10_000_000)
        case .maxStandard:  return (2_000_000, 8_000_000, 40_000_000)
        case .maxPlus:      return (4_000_000, 16_000_000, 80_000_000)
        }
    }
}

struct CueSettingsView: View {
    @AppStorage("showInDock") var showInDock = true
    @AppStorage("startAtLogin") var startAtLogin = false
    @AppStorage("fiveHourTokenLimit") var fiveHourLimit = 0
    @AppStorage("dailyTokenLimit") var dailyLimit = 0
    @AppStorage("weeklyTokenLimit") var weeklyLimit = 0
    @State private var selectedPlan = PlanPreset.custom
    @State private var fiveHourText = ""
    @State private var dailyText = ""
    @State private var weeklyText = ""

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

            Section("Usage Limits") {
                Picker("Plan preset", selection: $selectedPlan) {
                    ForEach(PlanPreset.allCases, id: \.self) { plan in
                        Text(plan.rawValue).tag(plan)
                    }
                }
                .onChange(of: selectedPlan) { _, plan in
                    guard plan != .custom else { return }
                    let limits = plan.limits
                    fiveHourLimit = limits.fiveHour
                    dailyLimit = limits.daily
                    weeklyLimit = limits.weekly
                    fiveHourText = "\(limits.fiveHour)"
                    dailyText = "\(limits.daily)"
                    weeklyText = "\(limits.weekly)"
                }

                TokenLimitField(label: "5-hour limit", value: $fiveHourLimit, text: $fiveHourText)
                TokenLimitField(label: "Daily limit", value: $dailyLimit, text: $dailyText)
                TokenLimitField(label: "Weekly limit", value: $weeklyLimit, text: $weeklyText)

                Text("Set limits to show progress bars. Pick a plan preset or enter custom values.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 420)
        .onAppear {
            fiveHourText = fiveHourLimit > 0 ? "\(fiveHourLimit)" : ""
            dailyText = dailyLimit > 0 ? "\(dailyLimit)" : ""
            weeklyText = weeklyLimit > 0 ? "\(weeklyLimit)" : ""
            // Detect current plan
            selectedPlan = .custom
            for plan in PlanPreset.allCases where plan != .custom {
                if plan.limits == (fiveHourLimit, dailyLimit, weeklyLimit) {
                    selectedPlan = plan
                    break
                }
            }
        }
    }
}

struct TokenLimitField: View {
    let label: String
    @Binding var value: Int
    @Binding var text: String

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            TextField("0", text: $text)
                .textFieldStyle(.roundedBorder)
                .frame(width: 120)
                .monospacedDigit()
                .onChange(of: text) { _, newValue in
                    value = Int(newValue.filter(\.isNumber)) ?? 0
                }
            if value > 0 {
                Text(Format.tokens(value))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .frame(width: 50, alignment: .leading)
            }
        }
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

    var isDemo = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let showInDock = UserDefaults.standard.object(forKey: "showInDock") as? Bool ?? true
        NSApp.setActivationPolicy(showInDock ? .regular : .accessory)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        // Dynamic menu via delegate
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        // Check for --demo flag
        isDemo = CommandLine.arguments.contains("--demo")

        if isDemo {
            monitor.loadDemoData()
            updateIcon()
        } else {
            // Poll session status every second
            pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
                self?.monitor.pollStatus()
                self?.updateIcon()
            }

            // Refresh JSONL metrics every 5s
            metricsTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
                self?.monitor.refreshMetrics()
            }

            monitor.pollStatus()
            monitor.refreshMetrics()
        }

        // Blink animation every 0.5s
        animTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.blinkOn.toggle()
            self?.updateIcon()
        }

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
