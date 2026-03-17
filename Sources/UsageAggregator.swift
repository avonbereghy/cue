import Foundation

/// Scans all JSONL conversation logs and aggregates token usage by time window.
/// Uses incremental parsing — only reads new bytes appended since the last scan.
final class UsageAggregator {
    private let claudeProjectsPath: String

    // Incremental state: track byte offset per file so we only parse new content
    private var fileOffsets: [String: UInt64] = [:]
    // Cached parsed entries per file (only entries within the widest window)
    private var cachedEntries: [String: [UsageEntry]] = [:]

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

    /// Aggregate usage across all JSONL files for each time window.
    /// Incrementally reads only new bytes from files since the last call.
    func aggregate() -> [UsageWindow: WindowMetrics] {
        let now = Date()
        var results: [UsageWindow: WindowMetrics] = [:]
        for window in UsageWindow.allCases {
            results[window] = WindowMetrics()
        }

        let windowStarts = Dictionary(uniqueKeysWithValues: UsageWindow.allCases.map {
            ($0, $0.startDate(from: now))
        })

        let oldestStart = windowStarts.values.min() ?? now

        let jsonlFiles = findRecentJSONLFiles(modifiedSince: oldestStart)

        for filePath in jsonlFiles {

            // Parse only new bytes appended since last scan
            let newEntries = parseNewBytes(at: filePath, since: oldestStart)

            // Merge new entries into cache
            if !newEntries.isEmpty {
                cachedEntries[filePath, default: []].append(contentsOf: newEntries)
            }

            // Prune old entries from cache (older than widest window)
            if var entries = cachedEntries[filePath] {
                entries.removeAll { $0.timestamp < oldestStart }
                cachedEntries[filePath] = entries
            }

            guard let entries = cachedEntries[filePath], !entries.isEmpty else { continue }

            // Aggregate into window buckets
            var sessionContributes: Set<UsageWindow> = []

            for entry in entries {
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

    /// Find JSONL files modified since the cutoff date.
    /// Skips entire project directories whose mod date is older than the cutoff.
    private func findRecentJSONLFiles(modifiedSince cutoff: Date) -> [String] {
        var files: [String] = []
        let fm = FileManager.default

        guard let projectDirs = try? fm.contentsOfDirectory(atPath: claudeProjectsPath) else {
            return files
        }

        for dir in projectDirs {
            let dirPath = "\(claudeProjectsPath)/\(dir)"

            // Skip entire project directory if it hasn't been modified recently
            if let attrs = try? fm.attributesOfItem(atPath: dirPath),
               let modDate = attrs[.modificationDate] as? Date,
               modDate < cutoff {
                continue
            }

            guard let contents = try? fm.contentsOfDirectory(atPath: dirPath) else { continue }
            for file in contents where file.hasSuffix(".jsonl") {
                let filePath = "\(dirPath)/\(file)"
                // Skip files not modified since cutoff
                if let attrs = try? fm.attributesOfItem(atPath: filePath),
                   let modDate = attrs[.modificationDate] as? Date,
                   modDate < cutoff {
                    continue
                }
                files.append(filePath)
            }
        }

        return files
    }

    // MARK: - Incremental JSONL Parsing

    struct UsageEntry: Sendable {
        let timestamp: Date
        let inputTokens: Int
        let outputTokens: Int
        let isUserMessage: Bool
        let isAssistantMessage: Bool
        let toolCounts: [String: Int]
        let model: String
    }

    /// Maximum bytes to read on first scan of a file (2MB tail).
    /// Subsequent reads are incremental (only new appended bytes).
    private static let maxInitialRead: UInt64 = 2 * 1024 * 1024

    /// Read only bytes appended since the last call for this file.
    /// On first read, only reads the last 2MB to avoid parsing huge historical files.
    private func parseNewBytes(at path: String, since cutoff: Date) -> [UsageEntry] {
        guard let handle = FileHandle(forReadingAtPath: path) else { return [] }
        defer { handle.closeFile() }

        handle.seekToEndOfFile()
        let fileSize = handle.offsetInFile

        var lastOffset = fileOffsets[path] ?? 0

        // If file was truncated/replaced, re-read
        if lastOffset > fileSize { lastOffset = 0 }

        // First time seeing this file — only read the tail
        if lastOffset == 0 && fileSize > Self.maxInitialRead {
            lastOffset = fileSize - Self.maxInitialRead
        }

        guard fileSize > lastOffset else {
            fileOffsets[path] = fileSize
            return []
        }

        handle.seek(toFileOffset: lastOffset)
        let newData = handle.readData(ofLength: Int(fileSize - lastOffset))
        fileOffsets[path] = fileSize

        guard let content = String(data: newData, encoding: .utf8) else { return [] }

        var entries: [UsageEntry] = []

        for line in content.components(separatedBy: .newlines) where !line.isEmpty {
            guard let data = line.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = json["type"] as? String else { continue }

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
