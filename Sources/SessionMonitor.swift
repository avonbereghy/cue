import Foundation

@Observable
final class SessionMonitor {
    var enrichedSessions: [EnrichedSession] = []
    var usageMetrics: [UsageWindow: WindowMetrics] = [:]

    private let statusFilePath: String
    private let claudeProjectsPath: String
    private var metricsCache: [String: SessionMetrics] = [:]
    private var fileModDates: [String: Date] = [:]
    private var resolvedPaths: [String: String] = [:]
    private var lastStatusModDate: Date?
    private let usageAggregator = UsageAggregator()

    func tokenLimit(for window: UsageWindow) -> Int {
        UserDefaults.standard.integer(forKey: window.settingsKey)
    }

    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        statusFilePath = "\(home)/Library/Application Support/Claude Cue/sessions.json"
        claudeProjectsPath = "\(home)/.claude/projects"
    }

    /// Load demo seed data for screenshots/previews
    func loadDemoData() {
        // Set demo token limits so progress bars appear
        let defaults = UserDefaults.standard
        if defaults.integer(forKey: "fiveHourTokenLimit") == 0 {
            let preset = PlanPreset.maxStandard.limits
            defaults.set(preset.fiveHour, forKey: "fiveHourTokenLimit")
            defaults.set(preset.daily, forKey: "dailyTokenLimit")
            defaults.set(preset.weekly, forKey: "weeklyTokenLimit")
        }

        let now = Date().timeIntervalSince1970

        let demoSessions: [(id: String, workspace: String, state: String, startedAt: Double)] = [
            ("demo-1", "/Users/dev/Projects/WebApp", "working", now - 2281),
            ("demo-2", "/Users/dev/Projects/APIServer", "done", now - 645),
            ("demo-3", "/Users/dev/Projects/MLPipeline", "waiting", now - 1520),
            ("demo-4", "/Users/dev/Projects/MobileApp", "done", now - 378),
            ("demo-5", "/Users/dev/Projects/InfraConfig", "subagent", now - 912),
        ]

        let demoMetrics: [String: SessionMetrics] = [
            "demo-1": SessionMetrics(
                messageCount: 87, userMessageCount: 42, inputTokens: 12_400, outputTokens: 35_800,
                cacheCreationTokens: 8_200, cacheReadTokens: 72_600, model: "claude-opus-4-6",
                lastInputTokens: 118_500, customTitle: nil, gitBranch: "feat/dashboard",
                toolCounts: ["Bash": 24, "Edit": 15, "Read": 12, "Write": 8, "Glob": 6, "Agent": 3, "Grep": 2]
            ),
            "demo-2": SessionMetrics(
                messageCount: 31, userMessageCount: 14, inputTokens: 5_800, outputTokens: 12_200,
                cacheCreationTokens: 3_100, cacheReadTokens: 28_400, model: "claude-opus-4-6",
                lastInputTokens: 42_300, customTitle: "Auth Refactor", gitBranch: "fix/oauth-flow",
                toolCounts: ["Read": 9, "Edit": 7, "Bash": 5, "Grep": 3]
            ),
            "demo-3": SessionMetrics(
                messageCount: 53, userMessageCount: 28, inputTokens: 9_100, outputTokens: 22_500,
                cacheCreationTokens: 5_500, cacheReadTokens: 51_200, model: "claude-sonnet-4-6",
                lastInputTokens: 78_600, customTitle: nil, gitBranch: "main",
                toolCounts: ["Bash": 18, "Read": 11, "TodoWrite": 5, "Agent": 4, "Write": 3]
            ),
            "demo-4": SessionMetrics(
                messageCount: 15, userMessageCount: 8, inputTokens: 2_900, outputTokens: 6_400,
                cacheCreationTokens: 1_800, cacheReadTokens: 14_200, model: "claude-sonnet-4-6",
                lastInputTokens: 21_700, customTitle: "UI Tests", gitBranch: "test/e2e-suite",
                toolCounts: ["Bash": 7, "Write": 4, "Read": 3, "Edit": 2]
            ),
            "demo-5": SessionMetrics(
                messageCount: 44, userMessageCount: 20, inputTokens: 7_600, outputTokens: 18_900,
                cacheCreationTokens: 4_200, cacheReadTokens: 38_700, model: "claude-opus-4-6",
                lastInputTokens: 65_400, customTitle: nil, gitBranch: nil,
                toolCounts: ["Bash": 12, "Read": 8, "Agent": 6, "Glob": 4, "ToolSearch": 2, "Edit": 1]
            ),
        ]

        enrichedSessions = demoSessions.map { demo in
            EnrichedSession(
                info: SessionInfo(
                    id: demo.id,
                    workspace: demo.workspace,
                    state: demo.state,
                    lastActivity: now,
                    startedAt: demo.startedAt
                ),
                metrics: demoMetrics[demo.id] ?? SessionMetrics()
            )
        }

        // Demo usage metrics
        usageMetrics = [
            .fiveHour: WindowMetrics(
                inputTokens: 37_800, outputTokens: 95_800,
                sessionCount: 5, userMessageCount: 112, assistantMessageCount: 230,
                toolCounts: ["Bash": 66, "Read": 43, "Edit": 25, "Write": 15, "Glob": 10, "Agent": 13, "Grep": 5, "TodoWrite": 5],
                modelTokens: [
                    "claude-opus-4-6": (input: 25_800, output: 67_100),
                    "claude-sonnet-4-6": (input: 12_000, output: 28_700)
                ]
            ),
            .daily: WindowMetrics(
                inputTokens: 82_400, outputTokens: 198_500,
                sessionCount: 11, userMessageCount: 245, assistantMessageCount: 490,
                toolCounts: ["Bash": 142, "Read": 95, "Edit": 58, "Write": 32, "Agent": 28, "Glob": 22, "Grep": 14, "TodoWrite": 10],
                modelTokens: [
                    "claude-opus-4-6": (input: 58_200, output: 145_300),
                    "claude-sonnet-4-6": (input: 24_200, output: 53_200)
                ]
            ),
            .weekly: WindowMetrics(
                inputTokens: 412_000, outputTokens: 1_024_000,
                sessionCount: 47, userMessageCount: 1_180, assistantMessageCount: 2_340,
                toolCounts: ["Bash": 680, "Read": 455, "Edit": 290, "Write": 162, "Agent": 134, "Glob": 108, "Grep": 72, "TodoWrite": 48],
                modelTokens: [
                    "claude-opus-4-6": (input: 290_000, output: 720_000),
                    "claude-sonnet-4-6": (input: 122_000, output: 304_000)
                ]
            ),
        ]
    }

    /// Poll sessions.json for current session states (called every ~1s)
    func pollStatus() {
        // Skip if file hasn't been modified since last poll
        if let attrs = try? FileManager.default.attributesOfItem(atPath: statusFilePath),
           let modDate = attrs[.modificationDate] as? Date {
            if let lastMod = lastStatusModDate, lastMod == modDate {
                return  // No change — skip the read entirely
            }
            lastStatusModDate = modDate
        }

        guard let data = try? Data(contentsOf: URL(fileURLWithPath: statusFilePath)),
              let status = try? JSONDecoder().decode(StatusData.self, from: data) else {
            if !enrichedSessions.isEmpty { enrichedSessions = [] }
            return
        }

        let now = Date().timeIntervalSince1970
        let active = status.sessions.values
            .filter { session in
                let age = now - session.lastActivity
                switch session.state {
                case "idle":   return age < 60
                case "error":  return age < 300
                default:       return age < 1800
                }
            }
            .sorted { $0.startedAt < $1.startedAt }

        let newSessions = active.map { session in
            EnrichedSession(info: session, metrics: metricsCache[session.id] ?? SessionMetrics())
        }

        // Only update (and trigger SwiftUI re-render) if data actually changed
        if newSessions != enrichedSessions {
            enrichedSessions = newSessions
        }
    }

    /// Parse JSONL conversation logs for token metrics (called every ~5s)
    func refreshMetrics() {
        for session in enrichedSessions {
            let path = jsonlPath(for: session.info)
            guard FileManager.default.fileExists(atPath: path) else { continue }

            var metrics = metricsCache[session.id] ?? SessionMetrics()
            parseJSONLIncremental(at: path, into: &metrics)
            metricsCache[session.id] = metrics
        }
        // Also refresh usage aggregation
        refreshUsage()
    }

    /// Aggregate usage data across all JSONL files for time windows (called every ~5s)
    func refreshUsage() {
        let newMetrics = usageAggregator.aggregate()
        if newMetrics != usageMetrics {
            usageMetrics = newMetrics
        }
    }

    // MARK: - JSONL Parsing

    /// Find path to session's JSONL log file.
    /// Claude Code uses the git root (not necessarily the CWD) as the project directory,
    /// so we try the exact workspace encoding first, then walk up parent directories,
    /// and finally search all project directories as a fallback.
    private func jsonlPath(for session: SessionInfo) -> String {
        if let cached = resolvedPaths[session.id] { return cached }

        let filename = "\(session.id).jsonl"

        // Try exact workspace path and each parent directory
        var path = session.workspace
        while !path.isEmpty && path != "/" {
            let encoded = path.replacingOccurrences(of: "/", with: "-")
            let candidate = "\(claudeProjectsPath)/\(encoded)/\(filename)"
            if FileManager.default.fileExists(atPath: candidate) {
                resolvedPaths[session.id] = candidate
                return candidate
            }
            path = (path as NSString).deletingLastPathComponent
        }

        // Fallback: search all project directories
        if let dirs = try? FileManager.default.contentsOfDirectory(atPath: claudeProjectsPath) {
            for dir in dirs {
                let candidate = "\(claudeProjectsPath)/\(dir)/\(filename)"
                if FileManager.default.fileExists(atPath: candidate) {
                    resolvedPaths[session.id] = candidate
                    return candidate
                }
            }
        }

        // Not found — return the original encoding so it can be retried later
        let encoded = session.workspace.replacingOccurrences(of: "/", with: "-")
        return "\(claudeProjectsPath)/\(encoded)/\(filename)"
    }

    /// Parse new bytes from a JSONL file incrementally.
    /// Only reads content appended since the last parse (tracked via jsonlOffsets).
    private var jsonlOffsets: [String: UInt64] = [:]

    private func parseJSONLIncremental(at path: String, into existing: inout SessionMetrics) {
        guard let handle = FileHandle(forReadingAtPath: path) else { return }
        defer { handle.closeFile() }

        handle.seekToEndOfFile()
        let fileSize = handle.offsetInFile

        let lastOffset = jsonlOffsets[path] ?? 0
        let startOffset = lastOffset > fileSize ? 0 : lastOffset

        guard fileSize > startOffset else {
            jsonlOffsets[path] = fileSize
            return
        }

        // If re-reading from start (first time or file replaced), reset metrics
        if startOffset == 0 {
            existing = SessionMetrics()
        }

        handle.seek(toFileOffset: startOffset)
        let newData = handle.readData(ofLength: Int(fileSize - startOffset))
        jsonlOffsets[path] = fileSize

        guard let content = String(data: newData, encoding: .utf8) else { return }

        for line in content.components(separatedBy: .newlines) where !line.isEmpty {
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = json["type"] as? String else { continue }

            if type == "custom-title", let title = json["customTitle"] as? String {
                existing.customTitle = title
            }

            if let branch = json["gitBranch"] as? String, branch != "HEAD" {
                existing.gitBranch = branch
            }

            if type == "user" {
                existing.userMessageCount += 1
            }

            guard type == "assistant",
                  let message = json["message"] as? [String: Any],
                  let usage = message["usage"] as? [String: Any] else { continue }

            existing.messageCount += 1

            if let model = message["model"] as? String {
                existing.model = model
            }

            if let content = message["content"] as? [[String: Any]] {
                for block in content {
                    if block["type"] as? String == "tool_use",
                       let name = block["name"] as? String {
                        existing.toolCounts[name, default: 0] += 1
                    }
                }
            }

            let input = usage["input_tokens"] as? Int ?? 0
            let output = usage["output_tokens"] as? Int ?? 0
            let cacheCreate = usage["cache_creation_input_tokens"] as? Int ?? 0
            let cacheRead = usage["cache_read_input_tokens"] as? Int ?? 0

            existing.inputTokens += input
            existing.outputTokens += output
            existing.cacheCreationTokens += cacheCreate
            existing.cacheReadTokens += cacheRead
            existing.lastInputTokens = input + cacheCreate + cacheRead
        }
    }
}
