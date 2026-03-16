import Foundation

/// Scans all JSONL conversation logs and aggregates token usage by time window.
final class UsageAggregator: Sendable {
    private let claudeProjectsPath: String

    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        claudeProjectsPath = "\(home)/.claude/projects"

        // Default to Max $100/mo limits if no limits configured
        let defaults = UserDefaults.standard
        if defaults.integer(forKey: "fiveHourTokenLimit") == 0
            && defaults.integer(forKey: "dailyTokenLimit") == 0
            && defaults.integer(forKey: "weeklyTokenLimit") == 0 {
            let preset = PlanPreset.maxStandard.limits
            defaults.set(preset.fiveHour, forKey: "fiveHourTokenLimit")
            defaults.set(preset.daily, forKey: "dailyTokenLimit")
            defaults.set(preset.weekly, forKey: "weeklyTokenLimit")
        }
    }

    /// Aggregate usage across all JSONL files for each time window
    func aggregate() -> [UsageWindow: WindowMetrics] {
        let now = Date()
        var results: [UsageWindow: WindowMetrics] = [:]
        for window in UsageWindow.allCases {
            results[window] = WindowMetrics()
        }

        let windowStarts = Dictionary(uniqueKeysWithValues: UsageWindow.allCases.map {
            ($0, $0.startDate(from: now))
        })

        // Oldest window start — skip files that can't possibly have relevant data
        let oldestStart = windowStarts.values.min() ?? now

        // Find and parse all JSONL files
        let jsonlFiles = findAllJSONLFiles()

        for filePath in jsonlFiles {
            // Quick check: skip files not modified since the oldest window start
            if let attrs = try? FileManager.default.attributesOfItem(atPath: filePath),
               let modDate = attrs[.modificationDate] as? Date {
                if modDate < oldestStart { continue }
            }

            let sessionEntries = parseJSONLForUsage(at: filePath, since: oldestStart)
            guard !sessionEntries.isEmpty else { continue }

            // Track which windows this session contributes to (for session count)
            var sessionContributes: Set<UsageWindow> = []

            for entry in sessionEntries {
                for window in UsageWindow.allCases {
                    guard let start = windowStarts[window], entry.timestamp >= start else { continue }

                    sessionContributes.insert(window)
                    results[window]!.inputTokens += entry.inputTokens
                    results[window]!.outputTokens += entry.outputTokens

                    if entry.isUserMessage {
                        results[window]!.userMessageCount += 1
                    }
                    if entry.isAssistantMessage {
                        results[window]!.assistantMessageCount += 1
                    }

                    for (tool, count) in entry.toolCounts {
                        results[window]!.toolCounts[tool, default: 0] += count
                    }

                    if !entry.model.isEmpty && (entry.inputTokens > 0 || entry.outputTokens > 0) {
                        let existing = results[window]!.modelTokens[entry.model] ?? (input: 0, output: 0)
                        results[window]!.modelTokens[entry.model] = (
                            input: existing.input + entry.inputTokens,
                            output: existing.output + entry.outputTokens
                        )
                    }
                }
            }

            for window in sessionContributes {
                results[window]!.sessionCount += 1
            }
        }

        return results
    }

    // MARK: - File Discovery

    private func findAllJSONLFiles() -> [String] {
        var files: [String] = []
        let fm = FileManager.default

        guard let projectDirs = try? fm.contentsOfDirectory(atPath: claudeProjectsPath) else {
            return files
        }

        for dir in projectDirs {
            let dirPath = "\(claudeProjectsPath)/\(dir)"
            guard let contents = try? fm.contentsOfDirectory(atPath: dirPath) else { continue }
            for file in contents where file.hasSuffix(".jsonl") {
                files.append("\(dirPath)/\(file)")
            }
        }

        return files
    }

    // MARK: - JSONL Parsing for Usage

    struct UsageEntry: Sendable {
        let timestamp: Date
        let inputTokens: Int
        let outputTokens: Int
        let isUserMessage: Bool
        let isAssistantMessage: Bool
        let toolCounts: [String: Int]
        let model: String
    }

    private func parseJSONLForUsage(at path: String, since cutoff: Date) -> [UsageEntry] {
        guard let content = try? String(contentsOf: URL(fileURLWithPath: path), encoding: .utf8) else {
            return []
        }

        var entries: [UsageEntry] = []

        for line in content.components(separatedBy: .newlines) where !line.isEmpty {
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = json["type"] as? String else { continue }

            // Extract timestamp — try multiple formats
            let timestamp: Date
            if let ts = json["timestamp"] as? Double {
                timestamp = Date(timeIntervalSince1970: ts)
            } else if let ts = json["timestamp"] as? String {
                timestamp = parseISO8601(ts) ?? Date.distantPast
            } else if let ts = json["isoTimestamp"] as? String {
                timestamp = parseISO8601(ts) ?? Date.distantPast
            } else {
                continue
            }

            // Skip entries older than the oldest window
            guard timestamp >= cutoff else { continue }

            if type == "user" {
                entries.append(UsageEntry(
                    timestamp: timestamp,
                    inputTokens: 0, outputTokens: 0,
                    isUserMessage: true, isAssistantMessage: false,
                    toolCounts: [:], model: ""
                ))
                continue
            }

            guard type == "assistant",
                  let message = json["message"] as? [String: Any],
                  let usage = message["usage"] as? [String: Any] else { continue }

            let model = message["model"] as? String ?? ""
            let input = usage["input_tokens"] as? Int ?? 0
            let output = usage["output_tokens"] as? Int ?? 0

            var tools: [String: Int] = [:]
            if let content = message["content"] as? [[String: Any]] {
                for block in content {
                    if block["type"] as? String == "tool_use",
                       let name = block["name"] as? String {
                        tools[name, default: 0] += 1
                    }
                }
            }

            entries.append(UsageEntry(
                timestamp: timestamp,
                inputTokens: input, outputTokens: output,
                isUserMessage: false, isAssistantMessage: true,
                toolCounts: tools, model: model
            ))
        }

        return entries
    }

    private func parseISO8601(_ string: String) -> Date? {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fmt.date(from: string) { return d }
        fmt.formatOptions = [.withInternetDateTime]
        return fmt.date(from: string)
    }
}
