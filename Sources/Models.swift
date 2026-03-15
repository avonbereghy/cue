import Foundation

// MARK: - Session Status (from sessions.json via hooks)

struct SessionInfo: Codable, Identifiable, Sendable {
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

struct SessionMetrics: Sendable {
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

struct EnrichedSession: Identifiable, Sendable {
    let info: SessionInfo
    var metrics: SessionMetrics

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
}
