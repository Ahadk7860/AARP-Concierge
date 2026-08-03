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

    // MARK: AMENDMENT-001 — what the gist producer needs and could not get
    //
    // These four exist so `boi_intel.gist` can build a `ThreadStats` from a digest
    // instead of from a `chat.db`. Before them the producer had to be handed a corpus
    // path, which put the corpus in the cloud — the one thing the design forbids.
    //
    // `momentum` is deliberately absent: `ThreadStats.momentum` is a property over
    // `messages_last_90d / messages_prior_90d`, and `momentum_90d` above already carries
    // exactly that ratio.

    /// Who sent the last message before the thread went quiet.
    ///
    /// **`classify()` gates `action_needed` on `not last_from_me`,** so without this the
    /// state the entire daily brief exists to deliver can never be produced — a
    /// digest-driven producer emits only `fading` and `dormant`, silently. Also the
    /// largest single term in `priority()`, at +0.35.
    public var last_from_me: Bool
    /// The longest silence this thread has ever had. `classify()` gates `revived` on it.
    public var max_gap_days: Int
    /// The other person asked something the user has not answered. +0.20 in `priority()`,
    /// and it selects the specific `sql_gist_text` branches.
    public var unanswered_question: Bool
    /// **THE FABRICATION-GATE ALLOWLIST.** Same shape and same rule as `gist.v1.facts`:
    /// 3 words and 40 characters per token, no verbatim spans, enforced by the same code
    /// path rather than a second one that can drift. These tokens under these caps were
    /// already licensed to leave the Mac inside a `gist.v1`; carrying them here changes
    /// the envelope, not the information.
    public var facts: Facts
    public var median_reply_latency_s: LatencyPair?
    public var p90_reply_latency_s: LatencyPair?
    public var tapbacks: Tapbacks?
    public var muted_by_them: Bool?
    public var green_share: Double?
    public var calls: CallStats?
    public var archetype: Archetype?
    public var as_of: String
}

/// The fabrication-gate allowlist, identical in shape to `gist.v1.facts`.
///
/// Five keys, always present, empty lists allowed — a thread that mentions nothing
/// specific is a valid and common answer, and the drafter reading an absent key is not a
/// case anybody should have to handle.
public struct Facts: Codable, Sendable, Equatable {
    public var dates: [String]
    public var times: [String]
    public var places: [String]
    public var amounts: [String]
    public var names: [String]

    public init(dates: [String] = [], times: [String] = [], places: [String] = [],
                amounts: [String] = [], names: [String] = []) {
        self.dates = dates
        self.times = times
        self.places = places
        self.amounts = amounts
        self.names = names
    }

    public static let empty = Facts()

    /// Every token, for the cap and no-verbatim checks that run over all five lists.
    public var allTokens: [String] { dates + times + places + amounts + names }
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
