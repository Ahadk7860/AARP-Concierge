import Foundation

/// Is this corpus good enough to build a report from, and if not, what can the user do?
///
/// **This is the most important screen in the app.** A user grants Full Disk Access —
/// the hardest thing we will ever ask of them — the scan runs, and it finds 400 messages
/// instead of 84,000. They do not conclude "my sync is off". They conclude the product
/// is bad, and they are right to, because a thin report presented as their year in
/// messages is a bad product. Estimated to affect 15–30% of the first cohort, which
/// makes it a first-class state rather than an error path.
///
/// Two product rules from CONTRACTS.md § 6 shape every string in this file:
///
/// - **Invitation, never verdict.** Every reveal ships with a one-tap remedy. Guilt
///   without agency is repellent; guilt with a button is a product.
/// - **Degrade, never fabricate.** `thin` says so honestly and offers to come back in a
///   week. It never hands somebody a bad report and calls it their year in messages.
public struct HealthCheck {

    // MARK: - Thresholds, stated

    /// Below this there is not enough to say anything true about somebody's year.
    public static let thinMessageCount = 500
    /// A corpus shorter than this cannot support a 90-day-over-90-day comparison at all.
    public static let thinSpanDays = 30
    /// The Mac is allowed to be asleep — CONTRACTS.md § 0 — but staleness is a visible
    /// state, never a silent wrong answer.
    public static let staleSyncDays = 7
    /// SMS reaches the Mac only through Text Message Forwarding, which has **no
    /// server-side queue**: if the Mac was asleep those messages may never arrive at
    /// all. So a corpus with almost no green in it, on a Mac whose owner demonstrably
    /// has green-bubble contacts, is not a user with no Android friends — it is
    /// forwarding switched off, and the missing messages are gone for good.
    public static let lowGreenShare = 0.02
    /// Below this the green-share signal is noise: a small corpus can legitimately have
    /// no SMS in it at all.
    public static let greenShareMinimumMessages = 2_000

    // MARK: - Inputs the mirror cannot supply

    /// State that lives outside `chat.db` and outside the mirror.
    ///
    /// Injected rather than read inside `evaluate` so the classification is a pure
    /// function of its inputs and every branch is reachable from a test without a Mac in
    /// that state.
    public struct SystemState: Sendable {
        /// `nil` means "could not determine", which is a different answer from `false`
        /// and the schema has room for both.
        public var messagesInICloud: Bool?
        public var lowPowerMode: Bool
        /// The user has green-bubble contacts, so an all-blue corpus is suspicious.
        /// `nil` when the AddressBook is unreadable — no evidence either way.
        public var hasNonIMessageContacts: Bool?

        public init(messagesInICloud: Bool? = nil,
                    lowPowerMode: Bool = false,
                    hasNonIMessageContacts: Bool? = nil) {
            self.messagesInICloud = messagesInICloud
            self.lowPowerMode = lowPowerMode
            self.hasNonIMessageContacts = hasNonIMessageContacts
        }

        /// Reads what this Mac will tell us.
        ///
        /// `com.apple.madrid`'s `CloudKitSyncingEnabled` is Messages in iCloud, and it is
        /// an ordinary user preference — readable without Full Disk Access, which is
        /// what makes it usable *before* the grant. Absent means undetermined, never
        /// false: a machine that has never opened Messages has no key, and reporting
        /// that as "iCloud is off" would send the user to fix something that is not
        /// broken.
        public static func read() -> SystemState {
            SystemState(
                messagesInICloud: cloudKitSyncingEnabled(),
                lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled,
                hasNonIMessageContacts: nil
            )
        }

        static let messagesCloudDomain = "com.apple.madrid"
        static let messagesCloudKey = "CloudKitSyncingEnabled"

        static func cloudKitSyncingEnabled(
            domain: String = messagesCloudDomain,
            key: String = messagesCloudKey
        ) -> Bool? {
            guard let value = CFPreferencesCopyAppValue(key as CFString,
                                                        domain as CFString) else { return nil }
            return (value as? NSNumber)?.boolValue
        }
    }

    // MARK: - Output

    public struct Result: Sendable {
        public var health: CorpusHealth
        /// Frozen enum values from `digest.v1`. Never empty — `["none"]` when healthy.
        public var reasons: [String]
        public var remedies: [Remedy]
        /// `thin` means we do not produce a report. Anything else does.
        public var producesReport: Bool { health != .thin }
        /// The one line the morning text or the onboarding screen leads with.
        public var headline: String
    }

    /// A named, actionable fix. Prompt 07 renders these; this prompt decides them.
    ///
    /// `deepLink` is present only where a deep link genuinely exists. Inventing one that
    /// opens the wrong pane is worse than plain instructions, because the user follows
    /// it, sees no such setting, and concludes the app is confused about their Mac.
    public struct Remedy: Sendable, Equatable {
        public let id: String
        public let title: String
        public let body: String
        public let deepLink: String?
        /// Always present, and always sufficient on its own.
        public let fallbackInstructions: String
        /// Whether re-running the scan after the fix is worth offering.
        public let rescanAvailable: Bool
    }

    /// **The exact string the Definition of Done pins.** Full Disk Access is the only
    /// one of these settings that lives in System Settings and therefore the only one
    /// with a real deep link.
    public static let fullDiskAccessDeepLink =
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"

    public static let fullDiskAccessRemedy = Remedy(
        id: "full_disk_access",
        title: "Boi needs Full Disk Access to read your messages",
        body: "Your messages never leave this Mac. Boi reads them here and sends only "
            + "counts and dates to your phone.",
        deepLink: fullDiskAccessDeepLink,
        fallbackInstructions: "Open System Settings, go to Privacy & Security, then Full "
            + "Disk Access, and switch on Boi. Then quit and reopen Boi — macOS does not "
            + "apply the grant to an app that is already running.",
        rescanAvailable: true
    )

    /// Messages' Keep Messages setting is in the Messages app, not System Settings, so
    /// there is no deep link for it and this remedy does not pretend otherwise.
    public static func keepMessagesRemedy(window: String) -> Remedy {
        Remedy(
            id: "keep_messages",
            title: "Your Mac is only keeping the last \(window) of messages",
            body: "Everything before that has already been deleted by macOS, so it is all "
                + "Boi can see. Switching to Keep Forever means next year's report has "
                + "your whole history in it.",
            deepLink: nil,
            fallbackInstructions: "Open Messages, choose Messages > Settings from the "
                + "menu bar, click General, and set Keep Messages to Forever.",
            rescanAvailable: false
        )
    }

    public static let iCloudRemedy = Remedy(
        id: "messages_in_icloud",
        title: "Messages in iCloud is off",
        body: "Your Mac only has the messages that arrived while it was awake. Turning "
            + "on Messages in iCloud fills in the rest.",
        deepLink: nil,
        fallbackInstructions: "Open Messages, choose Messages > Settings, click iCloud, "
            + "and switch on Enable Messages in iCloud.",
        rescanAvailable: true
    )

    public static let textForwardingRemedy = Remedy(
        id: "text_message_forwarding",
        title: "Your green-bubble texts are not reaching this Mac",
        body: "SMS only reaches a Mac through Text Message Forwarding, and there is no "
            + "queue — anything that arrived while this Mac was asleep is not coming.",
        deepLink: nil,
        fallbackInstructions: "On your iPhone, open Settings > Messages > Text Message "
            + "Forwarding and switch on this Mac.",
        rescanAvailable: true
    )

    public static let staleSyncRemedy = Remedy(
        id: "stale_sync",
        title: "Boi has not seen new messages in a while",
        body: "The newest message on this Mac is over a week old. That usually means the "
            + "Mac has been asleep or closed.",
        deepLink: nil,
        fallbackInstructions: "Open Messages on this Mac and let it sit for a minute, "
            + "then run the scan again.",
        rescanAvailable: true
    )

    public static let lowPowerRemedy = Remedy(
        id: "low_power_mode",
        title: "Low Power Mode is holding back background syncing",
        body: "macOS pauses background work in Low Power Mode, so Messages may not be "
            + "pulling in new conversations.",
        deepLink: "x-apple.systempreferences:com.apple.Battery-Settings.extension",
        fallbackInstructions: "Open System Settings > Battery and set Low Power Mode to "
            + "Never, or plug the Mac in.",
        rescanAvailable: true
    )

    /// The `thin` copy. No remedy, because there is nothing the user did wrong and
    /// nothing for them to fix — only time passing.
    public static let thinHeadline =
        "There is not enough history on this Mac yet to build a report worth reading."
    public static let thinBody =
        "Boi found too few messages to say anything true about your year. Nothing is "
        + "broken — this Mac just has not seen much yet. Boi will keep collecting "
        + "quietly and text you in a week when there is enough."

    // MARK: - The decision

    /// Pure. Same inputs, same classification, every time.
    ///
    /// `DigestBuilder` calls this and nothing else, which is what makes it structurally
    /// impossible for `boi-cli health` and `corpus.health` in the digest to disagree —
    /// there is one function and two callers, not two implementations of one rule.
    public static func evaluate(corpus: MetricLibrary.CorpusMetrics,
                                system: SystemState = SystemState()) -> Result {
        var reasons: [String] = []
        var remedies: [Remedy] = []

        // THIN FIRST, AND IT IS NOT OVERRIDDEN. A corpus this small cannot be made
        // trustworthy by fixing a setting, and offering a remedy would imply it could.
        let isThin = corpus.messageCount < thinMessageCount || corpus.spanDays < thinSpanDays
        if isThin {
            reasons.append("new_mac")
        }

        switch corpus.retentionBoundary {
        case "1y_exact", "365d":
            reasons.append("keep_messages_1y")
            if !isThin { remedies.append(keepMessagesRemedy(window: "year")) }
        case "30d_exact", "30d":
            reasons.append("keep_messages_30d")
            if !isThin { remedies.append(keepMessagesRemedy(window: "30 days")) }
        default:
            break
        }

        if system.messagesInICloud == false {
            reasons.append("icloud_off")
            if !isThin { remedies.append(iCloudRemedy) }
        }

        // Only claim this when there is enough corpus for the absence to mean something
        // AND the AddressBook says the user has somebody to text green.
        if corpus.messageCount >= greenShareMinimumMessages,
           corpus.greenShare < lowGreenShare,
           system.hasNonIMessageContacts == true {
            reasons.append("low_green_share")
            if !isThin { remedies.append(textForwardingRemedy) }
        }

        if corpus.daysSinceNewest >= staleSyncDays {
            reasons.append("stale_sync")
            if !isThin { remedies.append(staleSyncRemedy) }
        }

        if system.lowPowerMode {
            reasons.append("low_power_mode")
            if !isThin { remedies.append(lowPowerRemedy) }
        }

        let health: CorpusHealth = isThin ? .thin : (remedies.isEmpty ? .healthy : .fixable)
        return Result(health: health,
                      reasons: reasons.isEmpty ? ["none"] : reasons,
                      remedies: isThin ? [] : remedies,
                      headline: headline(health: health, corpus: corpus, remedies: remedies))
    }

    /// Invitation, never verdict — and never a number the user cannot check.
    static func headline(health: CorpusHealth,
                         corpus: MetricLibrary.CorpusMetrics,
                         remedies: [Remedy]) -> String {
        switch health {
        case .thin:
            return thinHeadline
        case .healthy:
            return "Boi read \(corpus.messageCount.formatted()) messages across "
                + "\(corpus.threadCount.formatted()) conversations. Everything looks good."
        case .fixable:
            let first = remedies.first?.title ?? "One setting is limiting what Boi can see"
            return "Boi read \(corpus.messageCount.formatted()) messages — and there is "
                + "more it could see. \(first)."
        }
    }
}

public extension RetentionBoundary {
    /// **The exact-boundary signature.**
    ///
    /// Apple's Keep Messages setting deletes on a rolling window, so a capped corpus
    /// spans the cap *precisely* — 365 days, or 30. A span of 364 or 366 is a person,
    /// not a policy: friendships do not start and stop on a schedule and no deletion
    /// rule produces an off-by-one window.
    ///
    /// Deliberately strict. The tolerant cousin is `detect`, which will still call a
    /// near-miss a boundary **when several threads pile up on the same day** — because
    /// the pile-up, not the span, is the real evidence.
    static func isExactBoundary(spanDays: Int) -> Bool {
        spanDays == oneYearDays || spanDays == thirtyDayDays
    }
}
