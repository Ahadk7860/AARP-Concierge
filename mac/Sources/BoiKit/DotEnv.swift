import Foundation

/// Reads one variable out of the worktree's `.env`.
///
/// Deliberately tiny and deliberately read-only. `.env` is per-worktree and gitignored
/// — worktrees share no untracked files — so the values a developer set for this track
/// are only reachable this way when the binary is launched by `swift run`, which does
/// not source it. The process environment always wins; this is a fallback, not an
/// override.
public enum DotEnv {

    public static let fileName = ".env"

    /// Walks up from `directory` looking for a `.env`, and returns `key` from the first
    /// one found. Stops at the filesystem root.
    public static func value(of key: String,
                             searchingFrom directory: String,
                             fileName: String = fileName) -> String? {
        var url = URL(fileURLWithPath: directory).standardizedFileURL
        while true {
            let candidate = url.appendingPathComponent(fileName)
            if let text = try? String(contentsOf: candidate, encoding: .utf8),
               let value = parse(text)[key], !value.isEmpty {
                return value
            }
            let parent = url.deletingLastPathComponent().standardizedFileURL
            if parent == url { return nil }
            url = parent
        }
    }

    /// `KEY=value`, one per line. Comments and blanks are skipped, and a trailing
    /// comment after a value is not stripped — the values in this project's `.env.example`
    /// carry them, and guessing where a value ends is worse than requiring quoting.
    public static func parse(_ text: String) -> [String: String] {
        var values: [String: String] = [:]
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#"),
                  let separator = line.firstIndex(of: "=") else { continue }
            let key = String(line[line.startIndex..<separator])
                .trimmingCharacters(in: .whitespaces)
            var value = String(line[line.index(after: separator)...])
                .trimmingCharacters(in: .whitespaces)
            if let comment = value.range(of: " #") {
                value = String(value[value.startIndex..<comment.lowerBound])
                    .trimmingCharacters(in: .whitespaces)
            }
            if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") {
                value = String(value.dropFirst().dropLast())
            }
            guard !key.isEmpty else { continue }
            values[key] = value
        }
        return values
    }
}
