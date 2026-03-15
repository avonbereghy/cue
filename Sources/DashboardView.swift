import SwiftUI

// MARK: - Dashboard Window

struct DashboardView: View {
    var monitor: SessionMonitor

    private var totalMessages: Int {
        monitor.enrichedSessions.reduce(0) { $0 + $1.metrics.messageCount }
    }

    private var totalTokens: Int {
        monitor.enrichedSessions.reduce(0) { $0 + $1.metrics.totalTokens }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Stats header
            HStack(spacing: 24) {
                StatBadge(
                    icon: "circle.fill",
                    label: "Sessions",
                    value: "\(monitor.enrichedSessions.count)",
                    color: .green
                )
                StatBadge(
                    icon: "message.fill",
                    label: "Messages",
                    value: "\(totalMessages)",
                    color: .blue
                )
                StatBadge(
                    icon: "arrow.up.arrow.down",
                    label: "Tokens",
                    value: Format.tokens(totalTokens),
                    color: .purple
                )
                Spacer()
            }
            .padding()
            .background(.ultraThinMaterial)

            Divider()

            // Session list
            if monitor.enrichedSessions.isEmpty {
                ContentUnavailableView {
                    Label("No Active Sessions", systemImage: "circle.dashed")
                } description: {
                    Text("Sessions will appear here when Claude Code is running")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(monitor.enrichedSessions) { session in
                            SessionCardView(session: session)
                        }
                    }
                    .padding()
                }
            }
        }
        .frame(minWidth: 680, minHeight: 300)
    }
}

// MARK: - Stat Badge

struct StatBadge: View {
    let icon: String
    let label: String
    let value: String
    let color: Color

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .font(.caption)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.headline)
                    .monospacedDigit()
            }
        }
    }
}

// MARK: - Session Card

struct SessionCardView: View {
    let session: EnrichedSession

    private var stateColor: Color {
        switch session.info.state {
        case "working":  return .white
        case "waiting":  return .yellow
        case "error":    return .red
        case "subagent": return .cyan
        case "idle":     return .gray
        case "done":     return .green
        default:         return .green
        }
    }

    private var contextColor: Color {
        let pct = session.contextUsagePercent
        if pct > 0.8 { return .red }
        if pct > 0.5 { return .orange }
        return .green
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Row 1: Status dot + title + state badge + duration
            HStack {
                Circle()
                    .fill(stateColor)
                    .frame(width: 10, height: 10)

                Text(session.displayTitle)
                    .font(.headline)
                    .foregroundStyle(stateColor)

                // Show workspace name as subtitle if custom title differs
                if session.metrics.customTitle != nil {
                    Text(session.workspaceName)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }

                Text(session.stateDisplayName)
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(stateColor.opacity(0.2))
                    .clipShape(Capsule())

                // Git branch
                if let branch = session.metrics.gitBranch {
                    Label(branch, systemImage: "arrow.triangle.branch")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                Spacer()

                Text(Format.duration(session.duration))
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            // Row 2: Metrics
            HStack(spacing: 16) {
                Label("\(session.metrics.userMessageCount)/\(session.metrics.messageCount)", systemImage: "message")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .help("User / Assistant messages")

                Label(Format.tokens(session.metrics.inputTokens) + " in", systemImage: "arrow.down.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Label(Format.tokens(session.metrics.outputTokens) + " out", systemImage: "arrow.up.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if session.metrics.totalToolUses > 0 {
                    Label("\(session.metrics.totalToolUses) tools", systemImage: "wrench")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if session.modelDisplayName != "—" {
                    Text(session.modelDisplayName)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                Spacer()
            }

            // Row 3: Tool breakdown chips
            if !session.metrics.topTools.isEmpty {
                HStack(spacing: 6) {
                    ForEach(session.metrics.topTools.prefix(6), id: \.name) { tool in
                        Text("\(tool.name) \(tool.count)")
                            .font(.system(.caption2, design: .monospaced))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.quaternary)
                            .clipShape(Capsule())
                    }
                    if session.metrics.topTools.count > 6 {
                        Text("+\(session.metrics.topTools.count - 6)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()

                    // Cache hit rate
                    if session.metrics.cacheCreationTokens + session.metrics.cacheReadTokens > 0 {
                        Text("Cache \(Int(session.metrics.cacheHitRate * 100))%")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            // Row 4: Context usage bar
            if session.metrics.lastInputTokens > 0 {
                HStack(spacing: 8) {
                    Text("Context")
                        .font(.caption2)
                        .foregroundStyle(.secondary)

                    ContextBar(percent: session.contextUsagePercent, color: contextColor)
                        .frame(height: 6)

                    Text("\(Int(session.contextUsagePercent * 100))%")
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)

                    Text(Format.tokens(session.metrics.lastInputTokens) + " / " + Format.tokens(session.contextLimit))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Context Usage Bar

struct ContextBar: View {
    let percent: Double
    let color: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3)
                    .fill(.quaternary)
                RoundedRectangle(cornerRadius: 3)
                    .fill(color)
                    .frame(width: geo.size.width * max(0.01, percent))
            }
        }
    }
}
