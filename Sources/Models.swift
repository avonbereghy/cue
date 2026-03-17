import Foundation

// MARK: - Session Status (from sessions.json via hooks)

struct SessionInfo: Codable, Identifiable, Sendable, Equatable {
    let id: String
    let workspace: String
    let state: String       // "working", "waiting", "error", "subagent", "idle", or "done"
    let lastActivity: Double
    let startedAt: Double
}

struct StatusData: Codable, Sendable {
    var sessions: [String: SessionInfo]
}

// MARK: - Session Metrics (parsed from JSONL conversation logs)

struct SessionMetrics: Sendable, Equatable {
    var messageCount: Int = 0
    var userMessageCount: Int = 0
    var inputTokens: Int = 0
    var outputTokens: Int = 0
    var cacheCreationTokens: Int = 0
    var cacheReadTokens: Int = 0
    var model: String = "unknown"
    var lastInputTokens: Int = 0  // Most recent message's input — approximates context usage
    var customTitle: String?
    var gitBranch: String?
    var toolCounts: [String: Int] = [:]

    var totalTokens: Int { inputTokens + outputTokens }

    var totalToolUses: Int { toolCounts.values.reduce(0, +) }

    /// Top tools sorted by usage count
    var topTools: [(name: String, count: Int)] {
        toolCounts.sorted { $0.value > $1.value }.map { ($0.key, $0.value) }
    }

    var cacheHitRate: Double {
        let total = cacheCreationTokens + cacheReadTokens
        guard total > 0 else { return 0 }
        return Double(cacheReadTokens) / Double(total)
    }
}

// MARK: - Enriched Session (combines hook state + JSONL metrics)

struct EnrichedSession: Identifiable, Sendable, Equatable {
    let info: SessionInfo
    var metrics: SessionMetrics

    static func == (lhs: EnrichedSession, rhs: EnrichedSession) -> Bool {
        lhs.info == rhs.info && lhs.metrics == rhs.metrics
    }

    var id: String { info.id }

    var workspaceName: String {
        URL(fileURLWithPath: info.workspace).lastPathComponent
    }

    var displayTitle: String {
        metrics.customTitle ?? workspaceName
    }

    var stateIcon: String {
        switch info.state {
        case "working":  return "⟳"
        case "waiting":  return "⏸"
        case "error":    return "✗"
        case "subagent": return "⤴"
        case "idle":     return "○"
        default:         return "✓"
        }
    }

    var stateDisplayName: String {
        switch info.state {
        case "working":  return "Working"
        case "waiting":  return "Waiting"
        case "error":    return "Error"
        case "subagent": return "Subagent"
        case "idle":     return "Idle"
        case "done":     return "Done"
        default:         return info.state.capitalized
        }
    }

    var duration: TimeInterval {
        Date().timeIntervalSince1970 - info.startedAt
    }

    var contextLimit: Int {
        let m = metrics.model.lowercased()
        if m.contains("opus") && m.contains("4-6") { return 1_000_000 }
        if m.contains("sonnet") && m.contains("4-6") { return 1_000_000 }
        return 200_000
    }

    var contextUsagePercent: Double {
        guard metrics.lastInputTokens > 0 else { return 0 }
        return min(1.0, Double(metrics.lastInputTokens) / Double(contextLimit))
    }

    var modelDisplayName: String {
        let m = metrics.model
        if m == "unknown" { return "—" }
        // "claude-sonnet-4-6" → "Sonnet 4.6"
        let cleaned = m.replacingOccurrences(of: "claude-", with: "")
        let parts = cleaned.split(separator: "-")
        if parts.count >= 3 {
            let name = parts[0].capitalized
            let version = parts[1...].joined(separator: ".")
            return "\(name) \(version)"
        }
        return m
    }
}

// MARK: - Usage Aggregation (across all sessions by time window)

enum UsageWindow: String, CaseIterable, Sendable {
    case fiveHour = "Session (5hr)"
    case daily = "Today"
    case weekly = "This Week"

    var displayName: String { rawValue }

    var settingsKey: String {
        switch self {
        case .fiveHour: return "fiveHourTokenLimit"
        case .daily:    return "dailyTokenLimit"
        case .weekly:   return "weeklyTokenLimit"
        }
    }

    /// How far back (in seconds) this window looks from now
    func startDate(from now: Date = Date()) -> Date {
        switch self {
        case .fiveHour:
            return now.addingTimeInterval(-5 * 3600)
        case .daily:
            return Calendar.current.startOfDay(for: now)
        case .weekly:
            var cal = Calendar.current
            cal.firstWeekday = 2  // Monday
            let components = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: now)
            return cal.date(from: components) ?? now.addingTimeInterval(-7 * 86400)
        }
    }

    /// When the current window resets, as a human-readable countdown
    func resetsIn(from now: Date = Date()) -> String {
        let resetDate: Date
        switch self {
        case .fiveHour:
            // Rolling window — "resets" when the oldest usage falls off (5h from first usage in window)
            // Approximate: show time until 5h from now
            resetDate = now.addingTimeInterval(5 * 3600)
        case .daily:
            // Resets at next midnight
            resetDate = Calendar.current.startOfDay(for: now).addingTimeInterval(86400)
        case .weekly:
            // Resets next Monday
            var cal = Calendar.current
            cal.firstWeekday = 2
            let components = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: now)
            let thisMonday = cal.date(from: components) ?? now
            resetDate = thisMonday.addingTimeInterval(7 * 86400)
        }

        let remaining = max(0, resetDate.timeIntervalSince(now))
        let hours = Int(remaining) / 3600
        let mins = (Int(remaining) % 3600) / 60

        if hours >= 24 {
            let days = hours / 24
            return "Resets in \(days)d"
        } else if hours > 0 {
            return "Resets in \(hours)h"
        } else {
            return "Resets in \(mins)m"
        }
    }
}

struct WindowMetrics: Sendable, Equatable {
    var inputTokens: Int = 0
    var outputTokens: Int = 0
    var sessionCount: Int = 0
    var userMessageCount: Int = 0
    var assistantMessageCount: Int = 0
    var toolCounts: [String: Int] = [:]
    var modelTokens: [String: (input: Int, output: Int)] = [:]

    static func == (lhs: WindowMetrics, rhs: WindowMetrics) -> Bool {
        lhs.inputTokens == rhs.inputTokens &&
        lhs.outputTokens == rhs.outputTokens &&
        lhs.sessionCount == rhs.sessionCount &&
        lhs.userMessageCount == rhs.userMessageCount &&
        lhs.assistantMessageCount == rhs.assistantMessageCount &&
        lhs.toolCounts == rhs.toolCounts
    }

    var totalTokens: Int { inputTokens + outputTokens }

    var topTools: [(name: String, count: Int)] {
        toolCounts.sorted { $0.value > $1.value }.map { ($0.key, $0.value) }
    }

    var totalToolUses: Int { toolCounts.values.reduce(0, +) }

    var estimatedCostUSD: Double {
        var cost = 0.0
        for (model, tokens) in modelTokens {
            let pricing = ModelPricing.forModel(model)
            cost += Double(tokens.input) * pricing.inputPerToken
            cost += Double(tokens.output) * pricing.outputPerToken
        }
        return cost
    }
}

// MARK: - Model Pricing (per-token USD rates)

struct ModelPricing: Sendable {
    let inputPerToken: Double
    let outputPerToken: Double

    /// Published API pricing as of 2025 (per token, not per million)
    static func forModel(_ model: String) -> ModelPricing {
        let m = model.lowercased()
        if m.contains("opus") {
            return ModelPricing(inputPerToken: 15.0 / 1_000_000, outputPerToken: 75.0 / 1_000_000)
        }
        if m.contains("sonnet") {
            return ModelPricing(inputPerToken: 3.0 / 1_000_000, outputPerToken: 15.0 / 1_000_000)
        }
        if m.contains("haiku") {
            return ModelPricing(inputPerToken: 0.80 / 1_000_000, outputPerToken: 4.0 / 1_000_000)
        }
        // Default to Sonnet pricing
        return ModelPricing(inputPerToken: 3.0 / 1_000_000, outputPerToken: 15.0 / 1_000_000)
    }
}

// MARK: - Formatting Helpers

enum Format {
    static func tokens(_ count: Int) -> String {
        if count < 1000 { return "\(count)" }
        if count < 1_000_000 { return String(format: "%.1fK", Double(count) / 1000.0) }
        return String(format: "%.1fM", Double(count) / 1_000_000.0)
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        let hrs = total / 3600
        let mins = (total % 3600) / 60
        let secs = total % 60
        if hrs > 0 { return String(format: "%dh %02dm", hrs, mins) }
        return String(format: "%dm %02ds", mins, secs)
    }

    static func cost(_ usd: Double) -> String {
        if usd < 0.01 { return "$0.00" }
        return String(format: "$%.2f", usd)
    }

    static func timeRange(from start: Date, to end: Date = Date()) -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm"
        return "\(fmt.string(from: start)) – \(fmt.string(from: end))"
    }
}
