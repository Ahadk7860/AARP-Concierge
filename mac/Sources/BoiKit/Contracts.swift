// Foundation-owned. Swift mirror of contracts/schema/*.json.
//
// No track modifies this file. A mismatch with the JSON Schema is a contract gap:
// record it in NOTES.md and report. Do not reconcile it locally.
//
// Verify round-trips with the language-neutral validator, which needs no Swift:
//     python3 scripts/validate_fixtures.py digest.v1 /tmp/boi-a/out/digest.json

import Foundation

public enum Archetype: String, Codable, Sendable {
    case fade, chapter
    case oneWayEnthusiasm = "one_way_enthusiasm"
    case theOneYouKeepWaiting = "the_one_you_keep_waiting"
    case risingFastest = "rising_fastest"
}

public enum CorpusHealth: String, Codable, Sendable {
    case healthy, fixable, thin
}

public struct LatencyPair: Codable, Sendable {
    public var user: Int?
    public var them: Int?
    public init(user: Int? = nil, them: Int? = nil) { self.user = user; self.them = them }
}

public struct Tapbacks: Codable, Sendable {
    public var given: Int
    public var received: Int
    public init(given: Int = 0, received: Int = 0) { self.given = given; self.received = received }
}

public struct CallStats: Codable, Sendable {
    public var count: Int
    public var total_seconds: Int
    public var initiated_by_user: Int
    public var missed: Int
    public init(count: Int = 0, total_seconds: Int = 0,
                initiated_by_user: Int = 0, missed: Int = 0) {
        self.count = count; self.total_seconds = total_seconds
        self.initiated_by_user = initiated_by_user; self.missed = missed
    }
}

public struct Relationship: Codable, Sendable {
    /// HMAC(user_salt, normalized_handle). The same phone number produces a DIFFERENT
    /// id for every user, so cross-user joins are arithmetically unavailable rather
    /// than merely forbidden. This cannot be retrofitted once there is data.
    public var contact_id: String
    public var display: String
    public var is_group: Bool
    public var message_count: Int
    public var sent_count: Int
    public var received_count: Int
    public var first_contact_at: String?
    public var last_contact_at: String?
    public var days_since_last_contact: Int
    /// Recent 90 days over prior 90 days. Observed range 0.0 to 13.9 -- this is where
    /// the signal is. Reciprocity (sd 0.034) is not.
    public var momentum_90d: Double
    public var initiation_ratio: Double
    public var median_reply_latency_s: LatencyPair?
    public var p90_reply_latency_s: LatencyPair?
    public var tapbacks: Tapbacks?
    public var muted_by_them: Bool?
    public var green_share: Double?
    public var calls: CallStats?
    public var archetype: Archetype?
    public var as_of: String
}

public struct CorpusSummary: Codable, Sendable {
    public var message_count: Int
    public var thread_count: Int
    public var first_message_at: String?
    public var last_message_at: String?
    public var span_days: Int
    public var green_share: Double?
    public var messages_in_icloud: Bool?
    public var retention_boundary: String?
    public var days_since_newest: Int?
    public var health: CorpusHealth
    public var health_reasons: [String]?
    public var as_of: String
}

public struct Digest: Codable, Sendable {
    public var schema_version: String = "digest.v1"
    public var user_id: String
    public var device_id: String
    public var generated_at: String
    public var corpus: CorpusSummary
    public var relationships: [Relationship]
    public var whole_life: WholeLife
}

public struct WholeLife: Codable, Sendable {
    public var total_messages: Int?
    public var unique_people: Int?
    public var global_median_reply_s: Int?
    public var concentration_top1: Double?
    public var concentration_top5: Double?
    public var concentration_top10: Double?
    public var relationships_gone_quiet: Int?
    public var relationships_ranked: Int?
    public var late_night_share: Double?
    public var as_of: String
}

public enum Punctuation: String, Codable, Sendable {
    case lowercaseNoPeriod = "lowercase_no_period"
    case lowercasePeriod = "lowercase_period"
    case sentenceCaseNoPeriod = "sentence_case_no_period"
    case sentenceCasePeriod = "sentence_case_period"
    case mixed
}

public struct Register: Codable, Sendable {
    public var median_len_chars: Int
    public var p90_len_chars: Int?
    public var emoji_rate: Double
    public var top_emoji: [String]?
    public var punctuation: Punctuation
    public var greeting_rate: Double?
    public var signoff_rate: Double?
    public var abbreviations: [String]?
    public var avg_msgs_per_burst: Double
    public var question_rate: Double?
    public var apology_openers: [String]?
}

/// THE USER'S OWN SENT MESSAGES ONLY.
///
/// Every exemplar must come from a `message` row where `is_from_me = 1`, and must be
/// redacted before serialization. One inbound message here makes every privacy claim
/// in BOI_ARCHITECTURE.md section 6 false, and nobody would notice for months.
///
/// This is guarded three times: the SQL query, the upload boundary, and a test that
/// fails the build. Do not remove any of the three.
public struct VoicePack: Codable, Sendable {
    public var schema_version: String = "voice_pack.v1"
    public var voice_pack_version: String
    public var contact_id: String?
    public var scope: String
    public var n_exemplars: Int
    public var register: Register
    public var exemplars: [String]
    public var as_of: String
}

/// FDA today, scoped bookmarks at launch. Everything above this protocol -- reader,
/// metrics, digest -- never learns which one it got, so the swap costs an afternoon
/// instead of a rewrite.
public protocol LocalStoreProvider {
    func url(for source: DataSource) throws -> URL
    func beginAccess() throws
    func endAccess()
}

public enum DataSource: String, Sendable, CaseIterable {
    case messages, attachments, contacts, callHistory
}
