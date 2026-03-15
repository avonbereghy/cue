import Foundation

@Observable
final class SessionMonitor {
    var enrichedSessions: [EnrichedSession] = []

    private let statusFilePath: String
    private let claudeProjectsPath: String
    private var metricsCache: [String: SessionMetrics] = [:]
    private var fileModDates: [String: Date] = [:]

    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        statusFilePath = "\(home)/Library/Application Support/Claude Cue/sessions.json"
        claudeProjectsPath = "\(home)/.claude/projects"
    }

    /// Load demo seed data for screenshots/previews
    func loadDemoData() {
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
    }

    /// Poll sessions.json for current session states (called every ~1s)
    func pollStatus() {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: statusFilePath)),
              let status = try? JSONDecoder().decode(StatusData.self, from: data) else {
            enrichedSessions = []
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

        enrichedSessions = active.map { session in
            EnrichedSession(info: session, metrics: metricsCache[session.id] ?? SessionMetrics())
        }
    }

    /// Parse JSONL conversation logs for token metrics (called every ~5s)
    func refreshMetrics() {
        for session in enrichedSessions {
            let path = jsonlPath(for: session.info)
            guard FileManager.default.fileExists(atPath: path) else { continue }

            // Skip if file hasn't changed since last parse
            if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
               let modDate = attrs[.modificationDate] as? Date {
                if let cached = fileModDates[session.id], cached == modDate {
                    continue
                }
                fileModDates[session.id] = modDate
            }

            if let metrics = parseJSONL(at: path) {
                metricsCache[session.id] = metrics
            }
        }
        // Rebuild enriched sessions with updated metrics
        pollStatus()
    }

    // MARK: - JSONL Parsing

    /// Construct path to session's JSONL log file
    /// Format: ~/.claude/projects/<encoded-workspace>/<session-id>.jsonl
    private func jsonlPath(for session: SessionInfo) -> String {
        let encoded = session.workspace.replacingOccurrences(of: "/", with: "-")
        return "\(claudeProjectsPath)/\(encoded)/\(session.id).jsonl"
    }

    /// Parse a JSONL file to extract token usage metrics
    private func parseJSONL(at path: String) -> SessionMetrics? {
        guard let content = try? String(contentsOf: URL(fileURLWithPath: path), encoding: .utf8) else {
            return nil
        }

        var m = SessionMetrics()

        for line in content.components(separatedBy: .newlines) where !line.isEmpty {
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = json["type"] as? String else { continue }

            // Extract custom title
            if type == "custom-title", let title = json["customTitle"] as? String {
                m.customTitle = title
            }

            // Track git branch from any message that has it
            if let branch = json["gitBranch"] as? String, branch != "HEAD" {
                m.gitBranch = branch
            }

            // Count user messages
            if type == "user" {
                m.userMessageCount += 1
            }

            // Parse assistant messages for tokens and tool usage
            guard type == "assistant",
                  let message = json["message"] as? [String: Any],
                  let usage = message["usage"] as? [String: Any] else { continue }

            m.messageCount += 1

            if let model = message["model"] as? String {
                m.model = model
            }

            // Count tool uses from message content
            if let content = message["content"] as? [[String: Any]] {
                for block in content {
                    if block["type"] as? String == "tool_use",
                       let name = block["name"] as? String {
                        m.toolCounts[name, default: 0] += 1
                    }
                }
            }

            let input = usage["input_tokens"] as? Int ?? 0
            let output = usage["output_tokens"] as? Int ?? 0
            let cacheCreate = usage["cache_creation_input_tokens"] as? Int ?? 0
            let cacheRead = usage["cache_read_input_tokens"] as? Int ?? 0

            m.inputTokens += input
            m.outputTokens += output
            m.cacheCreationTokens += cacheCreate
            m.cacheReadTokens += cacheRead
            // Context usage = all input tokens (non-cached + cached)
            m.lastInputTokens = input + cacheCreate + cacheRead
        }

        return m
    }
}
