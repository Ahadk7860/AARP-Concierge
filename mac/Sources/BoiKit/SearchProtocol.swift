import Foundation

/// Wire types for the `ask_device` protocol — V3_ARCHITECTURE.md §4.3, **frozen**.
///
/// Cloud sends this over the persistent WebSocket; the Mac decodes it, runs
/// `SearchRequestHandler`, and encodes the response back. These Codable types are the
/// byte-for-byte Swift mirror of the spec. The cloud-side TypeScript client
/// (`cloud/device-search`) implements the identical shape independently — keep both in
/// sync with §4.3 itself, not with each other, if the frozen contract ever changes.
///
/// ```ts
/// // request
/// { v: 1, id: string, op: "search", query: string,
///   who?: string, when_from?: string, when_to?: string, limit: number }
///
/// // response
/// { v: 1, id: string, ok: true,
///   results: Array<{ person_id, when, snippet, thread_id, score }> }
/// // or
/// { v: 1, id: string, ok: false, reason: "asleep"|"timeout"|"no_grant" }
/// ```
public struct AskDeviceSearchRequest: Codable, Sendable, Equatable {
    public var v: Int
    public var id: String
    public var op: String
    public var query: String
    public var who: String?
    public var when_from: String?
    public var when_to: String?
    public var limit: Int

    public init(
        v: Int = 1,
        id: String,
        op: String = "search",
        query: String,
        who: String? = nil,
        when_from: String? = nil,
        when_to: String? = nil,
        limit: Int
    ) {
        self.v = v
        self.id = id
        self.op = op
        self.query = query
        self.who = who
        self.when_from = when_from
        self.when_to = when_to
        self.limit = limit
    }
}

/// One hit. Note this is the §4.3 WIRE shape — `score`, no `display` — which differs
/// on purpose from §4.2's `search_messages` tool output (`display`, no `score`). Track
/// B's agent maps device rows to tool rows by looking `person_id` up against the
/// relationship store; this side never invents a display name.
public struct AskDeviceSearchResultRow: Codable, Sendable, Equatable {
    public var person_id: String
    public var when: String
    public var snippet: String
    public var thread_id: String
    public var score: Double

    public init(person_id: String, when: String, snippet: String, thread_id: String, score: Double) {
        self.person_id = person_id
        self.when = when
        self.snippet = snippet
        self.thread_id = thread_id
        self.score = score
    }
}

/// The three, and only three, honest failure reasons (§4.3, frozen). The agent branches
/// on `asleep` specifically to offer "want me to answer when your Mac is back?" — do
/// not add a fourth value or repurpose one of these for something else without amending
/// V3_ARCHITECTURE.md §4.3 first.
public enum AskDeviceFailureReason: String, Codable, Sendable {
    /// No live connection for this user at all — the cloud gateway decides this, never
    /// the Mac (a Mac that is running this code is, by definition, awake).
    case asleep
    /// A connection existed but did not answer inside the 4s budget — also a cloud-side
    /// determination.
    case timeout
    /// The one reason the Mac itself can emit: no active search grant (consent/FDA).
    case no_grant
}

/// A discriminated union, hand-rolled rather than derived, so `ok:false` responses never
/// carry a stray `"results": null` key and `ok:true` responses never carry a stray
/// `"reason": null` key — the wire shape is exactly one or the other, matching §4.3
/// byte-for-byte.
public enum AskDeviceSearchResponse: Sendable, Equatable {
    case ok(v: Int, id: String, results: [AskDeviceSearchResultRow])
    case failed(v: Int, id: String, reason: AskDeviceFailureReason)

    public var id: String {
        switch self {
        case .ok(_, let id, _): return id
        case .failed(_, let id, _): return id
        }
    }
}

extension AskDeviceSearchResponse: Codable {
    private enum CodingKeys: String, CodingKey { case v, id, ok, results, reason }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let v = try container.decode(Int.self, forKey: .v)
        let id = try container.decode(String.self, forKey: .id)
        let ok = try container.decode(Bool.self, forKey: .ok)
        if ok {
            let results = try container.decode([AskDeviceSearchResultRow].self, forKey: .results)
            self = .ok(v: v, id: id, results: results)
        } else {
            let reason = try container.decode(AskDeviceFailureReason.self, forKey: .reason)
            self = .failed(v: v, id: id, reason: reason)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .ok(let v, let id, let results):
            try container.encode(v, forKey: .v)
            try container.encode(id, forKey: .id)
            try container.encode(true, forKey: .ok)
            try container.encode(results, forKey: .results)
        case .failed(let v, let id, let reason):
            try container.encode(v, forKey: .v)
            try container.encode(id, forKey: .id)
            try container.encode(false, forKey: .ok)
            try container.encode(reason, forKey: .reason)
        }
    }
}
