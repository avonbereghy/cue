import SwiftUI

// MARK: - Usage Tab

struct UsageView: View {
    var monitor: SessionMonitor
    @AppStorage("fiveHourTokenLimit") private var fiveHourLimit = 0
    @AppStorage("dailyTokenLimit") private var dailyLimit = 0
    @AppStorage("weeklyTokenLimit") private var weeklyLimit = 0
    @State private var selectedPlan = PlanPreset.custom

    var body: some View {
        VStack(spacing: 0) {
            // Plan picker header
            HStack(spacing: 12) {
                Text("Plan")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Picker("", selection: $selectedPlan) {
                    ForEach(PlanPreset.allCases, id: \.self) { plan in
                        Text(plan.rawValue).tag(plan)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 400)
                .onChange(of: selectedPlan) { _, plan in
                    guard plan != .custom else { return }
                    let limits = plan.limits
                    fiveHourLimit = limits.fiveHour
                    dailyLimit = limits.daily
                    weeklyLimit = limits.weekly
                }
                Spacer()
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial)

            Divider()

            if monitor.usageMetrics.values.allSatisfy({ $0.totalTokens == 0 }) {
                emptyState
            } else {
                ScrollView {
                    VStack(spacing: 16) {
                        ForEach(UsageWindow.allCases, id: \.self) { window in
                            WindowSectionView(
                                window: window,
                                metrics: monitor.usageMetrics[window] ?? WindowMetrics(),
                                tokenLimit: monitor.tokenLimit(for: window)
                            )
                        }
                    }
                    .padding()
                }
            }
        }
        .frame(minWidth: 680, minHeight: 300)
        .onAppear {
            // Detect current plan from saved limits
            selectedPlan = .custom
            let current = (fiveHourLimit, dailyLimit, weeklyLimit)
            for plan in PlanPreset.allCases where plan != .custom {
                if plan.limits == current {
                    selectedPlan = plan
                    break
                }
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Usage Recorded", systemImage: "chart.bar")
        } description: {
            Text("Usage will appear here as you use Claude Code.")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Window Section

struct WindowSectionView: View {
    let window: UsageWindow
    let metrics: WindowMetrics
    let tokenLimit: Int

    private var progressPercent: Double {
        guard tokenLimit > 0 else { return 0 }
        return min(1.0, Double(metrics.totalTokens) / Double(tokenLimit))
    }

    private var progressColor: Color {
        if progressPercent > 0.8 { return .red }
        if progressPercent > 0.5 { return .orange }
        return .yellow
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header: window name + percentage + cost
            HStack {
                Text(window.displayName)
                    .font(.headline)

                Spacer()

                if tokenLimit > 0 {
                    Text("\(Int(progressPercent * 100))%")
                        .font(.title2)
                        .fontWeight(.semibold)
                        .monospacedDigit()
                        .foregroundStyle(progressColor)
                }

                if metrics.totalTokens > 0 {
                    Text(Format.cost(metrics.estimatedCostUSD))
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            // Progress bar (all windows when limit configured)
            if tokenLimit > 0 {
                VStack(alignment: .leading, spacing: 4) {
                    UsageProgressBar(percent: progressPercent, color: progressColor)
                        .frame(height: 8)

                    HStack {
                        Text(window.resetsIn())
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                        Spacer()
                        Text(Format.tokens(metrics.totalTokens) + " / " + Format.tokens(tokenLimit))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            // Stats row
            HStack(spacing: 16) {
                StatChip(icon: "arrow.up.arrow.down", label: "Tokens", value: Format.tokens(metrics.totalTokens), color: .purple)
                StatChip(icon: "arrow.down.circle", label: "In", value: Format.tokens(metrics.inputTokens), color: .blue)
                StatChip(icon: "arrow.up.circle", label: "Out", value: Format.tokens(metrics.outputTokens), color: .cyan)
                StatChip(icon: "circle.fill", label: "Sessions", value: "\(metrics.sessionCount)", color: .green)
                StatChip(icon: "message", label: "Messages", value: "\(metrics.userMessageCount + metrics.assistantMessageCount)", color: .blue)

                if metrics.totalToolUses > 0 {
                    StatChip(icon: "wrench", label: "Tools", value: "\(metrics.totalToolUses)", color: .orange)
                }

                Spacer()
            }

            // Tool breakdown chips
            if !metrics.topTools.isEmpty {
                HStack(spacing: 6) {
                    ForEach(metrics.topTools.prefix(8), id: \.name) { tool in
                        Text("\(tool.name) \(tool.count)")
                            .font(.system(.caption2, design: .monospaced))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.quaternary)
                            .clipShape(Capsule())
                    }
                    if metrics.topTools.count > 8 {
                        Text("+\(metrics.topTools.count - 8)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                }
            }

            // Model breakdown (if multiple models used)
            if metrics.modelTokens.count > 1 {
                HStack(spacing: 12) {
                    ForEach(Array(metrics.modelTokens.keys.sorted()), id: \.self) { model in
                        let tokens = metrics.modelTokens[model]!
                        let displayName = modelDisplayName(model)
                        Text("\(displayName): \(Format.tokens(tokens.input + tokens.output))")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                }
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func modelDisplayName(_ model: String) -> String {
        let m = model.replacingOccurrences(of: "claude-", with: "")
        let parts = m.split(separator: "-")
        if parts.count >= 3 {
            return "\(parts[0].capitalized) \(parts[1...].joined(separator: "."))"
        }
        return model
    }
}

// MARK: - Usage Progress Bar

struct UsageProgressBar: View {
    let percent: Double
    let color: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(.quaternary)
                RoundedRectangle(cornerRadius: 4)
                    .fill(color)
                    .frame(width: geo.size.width * max(0.01, percent))
            }
        }
    }
}

// MARK: - Stat Chip (compact inline stat)

struct StatChip: View {
    let icon: String
    let label: String
    let value: String
    let color: Color

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .font(.system(size: 9))
            Text(value)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .help(label)
    }
}
