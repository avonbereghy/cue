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
        statusFilePath = "\(home)/Library/Application Support/Cue/sessions.json"
        claudeProjectsPath = "\(home)/.claude/projects"
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
