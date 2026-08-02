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
        print(line(event, level: level, at: date, fields: fields))
    }
}
