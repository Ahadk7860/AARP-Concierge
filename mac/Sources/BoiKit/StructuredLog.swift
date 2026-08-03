import Foundation

/// Structured JSON to stdout, per CONTRACTS.md section 6.
///
/// Message bodies never appear in a log line. Counts, ids and hashes only.
public enum StructuredLog {

    public enum Level: String, Sendable {
        case info, warn, error
    }

    /// ISO 8601 UTC with a `Z`. No epoch integers cross a process line.
    public static func timestamp(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    /// Inverse of `timestamp`. Returns nil on anything this file did not write.
    public static func date(from string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }

    public static func line(_ event: String,
                            level: Level = .info,
                            at date: Date = Date(),
                            fields: [String: Any] = [:]) -> String {
        var payload: [String: Any] = fields
        payload["event"] = event
        payload["level"] = level.rawValue
        payload["as_of"] = timestamp(date)

        guard let data = try? JSONSerialization.data(withJSONObject: payload,
                                                     options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else {
            return #"{"event":"log_encode_failed","level":"error"}"#
        }
        return json
    }

    public static func emit(_ event: String,
                            level: Level = .info,
                            at date: Date = Date(),
                            fields: [String: Any] = [:]) {
        let line = line(event, level: level, at: date, fields: fields)
        print(line)
        append(line)
    }

    /// An optional file sink, in addition to stdout — never instead of it.
    ///
    /// A GUI app launched from the Finder and a job launched by `launchd` both have a
    /// stdout that goes nowhere anybody will look. The permission flow in prompt 07 is
    /// only auditable if it leaves a timestamped record on disk, and "did the relaunch
    /// happen inside two seconds" is not a question a screenshot can answer.
    ///
    /// Message bodies never appear here, same as stdout: counts, ids and hashes only.
    public static func setFileSink(_ url: URL?) {
        queue.sync { sink = url }
    }

    private static let queue = DispatchQueue(label: "app.boi.mac.log")
    private nonisolated(unsafe) static var sink: URL?

    private static func append(_ line: String) {
        queue.sync {
            guard let sink else { return }
            try? FileManager.default.createDirectory(
                at: sink.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard let data = (line + "\n").data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: sink) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            } else {
                try? data.write(to: sink, options: .atomic)
            }
        }
    }
}
