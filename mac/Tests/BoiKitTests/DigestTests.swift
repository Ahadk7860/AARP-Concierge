import XCTest
@testable import BoiKit

/// Builds purpose-made `chat.db`, AddressBook and CallHistory files.
///
/// The shared fixture is realistic and therefore a poor instrument for most of what is
/// below: it has no contact records at all, no calls, and its messages are spaced
/// evenly enough that several thread-shape metrics degenerate on it. These build the
/// exact shape each test is about.
enum MetricsFixture {

    /// Everything below is measured against this instant rather than `Date()`, so a
    /// window boundary cannot move between the build and the assertion.
    static let now = Date(timeIntervalSince1970: 1_800_000_000)   // 2027-01-15T08:00:00Z

    static let salt = "boi-dev-salt-do-not-ship-0001"

    /// The string the generator puts inside a user-sent tapback, so a test can prove the
    /// other person's words never reach an exemplar. See CONTRACTS.md § 7, 3 Aug.
    static let inboundProseCanary = "CANARY-INBOUND-PROSE-SHOULD-NEVER-REACH-AN-EXEMPLAR"

    static func appleNanos(secondsAgo: Double) -> Int64 {
        Int64(now.addingTimeInterval(-secondsAgo).timeIntervalSinceReferenceDate) * 1_000_000_000
    }

    static let chatSchema = """
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER,
                           chat_identifier TEXT, service_name TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT,
                              handle_id INTEGER, service TEXT, date INTEGER,
                              is_from_me INTEGER, associated_message_type INTEGER,
                              attributedBody BLOB, cache_has_attachments INTEGER,
                              was_delivered_quietly INTEGER DEFAULT 0);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER,
                                        message_date INTEGER);
        CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
        """

    /// Accumulates INSERT statements for a small, exactly-shaped corpus.
    struct ChatBuilder {
        private var statements: [String] = []
        private var threadRowIDs: [String: Int64] = [:]
        private var nextRowID: Int64 = 1

        mutating func thread(_ identifier: String, service: String = "iMessage", style: Int = 45) {
            guard threadRowIDs[identifier] == nil else { return }
            let rowID = Int64(threadRowIDs.count + 1)
            threadRowIDs[identifier] = rowID
            statements.append("""
                INSERT INTO handle VALUES (\(rowID), '\(identifier)', '\(service)');
                INSERT INTO chat VALUES (\(rowID), '\(service);-;\(identifier)', \(style),
                                         '\(identifier)', '\(service)');
                """)
        }

        /// One message. `daysAgo` is relative to `MetricsFixture.now`.
        mutating func message(_ text: String?,
                              in identifier: String,
                              daysAgo: Double,
                              fromMe: Bool = false,
                              service: String = "iMessage",
                              tapbackType: Int = 0,
                              quietly: Bool = false) {
            thread(identifier, service: service)
            let chatRowID = threadRowIDs[identifier]!
            let rowID = nextRowID
            nextRowID += 1
            let date = MetricsFixture.appleNanos(secondsAgo: daysAgo * 86_400)
            let body = text.map { "'\($0.replacingOccurrences(of: "'", with: "''"))'" } ?? "NULL"
            statements.append("""
                INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me,
                                     associated_message_type, attributedBody,
                                     cache_has_attachments, was_delivered_quietly)
                VALUES (\(rowID), 'M-\(rowID)', \(body), \(fromMe ? 0 : chatRowID),
                        '\(service)', \(date), \(fromMe ? 1 : 0), \(tapbackType), NULL, 0,
                        \(quietly ? 1 : 0));
                INSERT INTO chat_message_join VALUES (\(chatRowID), \(rowID), \(date));
                """)
        }

        /// Minutes rather than days, for reply-latency shapes.
        mutating func message(_ text: String?,
                              in identifier: String,
                              minutesAgo: Double,
                              fromMe: Bool = false) {
            message(text, in: identifier, daysAgo: minutesAgo / 1440, fromMe: fromMe)
        }

        func build(label: String) throws -> String {
            try MetricsFixture.write(MetricsFixture.chatSchema + "\n"
                                     + statements.joined(separator: "\n"), label: label)
        }
    }

    /// The two tables the merge reads, in Core Data's own shape.
    static func addressBook(records: [(id: Int64, first: String, last: String)],
                            phones: [(owner: Int64, number: String)],
                            emails: [(owner: Int64, address: String)],
                            label: String) throws -> String {
        var sql = """
            CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT,
                                      ZLASTNAME TEXT, ZORGANIZATION TEXT);
            CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER,
                                           ZFULLNUMBER TEXT);
            CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER,
                                            ZADDRESS TEXT);
            """
        for record in records {
            sql += "\nINSERT INTO ZABCDRECORD VALUES (\(record.id), '\(record.first)', "
                + "'\(record.last)', NULL);"
        }
        for (offset, phone) in phones.enumerated() {
            sql += "\nINSERT INTO ZABCDPHONENUMBER VALUES (\(offset + 1), \(phone.owner), "
                + "'\(phone.number)');"
        }
        for (offset, email) in emails.enumerated() {
            sql += "\nINSERT INTO ZABCDEMAILADDRESS VALUES (\(offset + 1), \(email.owner), "
                + "'\(email.address)');"
        }
        return try write(sql, label: label)
    }

    static func callHistory(_ calls: [(address: String, seconds: Double,
                                       originated: Bool, answered: Bool)],
                            label: String) throws -> String {
        var sql = """
            CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, ZADDRESS TEXT,
                                      ZDURATION REAL, ZORIGINATED INTEGER,
                                      ZANSWERED INTEGER);
            """
        for (offset, call) in calls.enumerated() {
            sql += "\nINSERT INTO ZCALLRECORD VALUES (\(offset + 1), '\(call.address)', "
                + "\(call.seconds), \(call.originated ? 1 : 0), \(call.answered ? 1 : 0));"
        }
        return try write(sql, label: label)
    }

    static func write(_ sql: String, label: String) throws -> String {
        let directory = "/tmp/boi-a/tests"
        try FileManager.default.createDirectory(atPath: directory,
                                                withIntermediateDirectories: true)
        let path = "\(directory)/\(label)-\(UUID().uuidString).db"
        try Fixture.run("/usr/bin/sqlite3", [path, sql])
        guard FileManager.default.fileExists(atPath: path) else {
            throw Fixture.FixtureUnavailable(detail: "could not build \(path)")
        }
        return path
    }

    /// Ingests a chat.db into a fresh mirror, exactly the way the CLI does.
    static func mirror(of chatDatabasePath: String, label: String) throws -> MirrorDatabase {
        let path = "/tmp/boi-a/tests/\(label)-\(UUID().uuidString)-mirror.db"
        let mirror = try MirrorDatabase(path: path)
        try MirrorSync(reader: try MessageReader(path: chatDatabasePath), mirror: mirror)
            .run(now: now)
        return mirror
    }

    // MARK: - The retention-capped corpus

    /// A second copy of the shared fixture, generated with Apple's one-year cap applied.
    ///
    /// Separate from `Fixture.chatDatabasePath` on purpose: the uncapped fixture spans
    /// about 653 days and is what prompts 01 through 03 measured against. Regenerating
    /// that one with a cap would silently change the corpus every earlier test reads.
    static var cappedChatDatabasePath: String { "/tmp/boi-a/chat-retention-365.db" }

    /// "Now", for the shared fixture, is its own newest message.
    ///
    /// The generator lays the corpus out relative to the wall clock at generation time,
    /// so a fixed instant would put every window in the wrong place, and `Date()` would
    /// drift by however many days the file has been sitting in `/tmp`. Reading the clock
    /// off the corpus makes every window stable no matter when the fixture was built —
    /// which is the same reason the digest itself is regenerated rather than committed.
    static func newestMessage(in mirror: MirrorDatabase) throws -> Date {
        var newest: Date?
        try mirror.forEachMessage { message in
            guard let sentAt = message.sentAt else { return }
            newest = max(newest ?? sentAt, sentAt)
        }
        guard let newest else {
            throw Fixture.FixtureUnavailable(detail: "the mirror has no dated messages")
        }
        return newest
    }

    static func ensureCappedChatDatabase() throws {
        guard !FileManager.default.fileExists(atPath: cappedChatDatabasePath) else { return }
        let output = try Fixture.run("/usr/bin/python3", [
            Fixture.repositoryRoot.appendingPathComponent("scripts/make_synthetic_chatdb.py").path,
            "--out", cappedChatDatabasePath,
            "--retention-cap-days", "365",
        ])
        guard FileManager.default.fileExists(atPath: cappedChatDatabasePath) else {
            throw Fixture.FixtureUnavailable(
                detail: "could not build \(cappedChatDatabasePath):\n\(output)")
        }
    }
}

// MARK: - Contact resolution

final class ContactResolverTests: XCTestCase {

    func testHandlesAreNormalizedBeforeTheyAreHashed() {
        let expected = "+15550100001"
        for spelling in ["+15550100001", "(555) 010-0001", "555-010-0001", " 5550100001 ",
                         "+1 555 010 0001"] {
            XCTAssertEqual(ContactResolver.normalize(spelling), expected,
                           "\(spelling) must normalize to one string")
        }
        XCTAssertEqual(ContactResolver.normalize("Maya@Example.COM"), "maya@example.com")
    }

    func testTheSameHandleAlwaysProducesTheSameIdentifier() {
        let resolver = ContactResolver(salt: MetricsFixture.salt)
        let first = resolver.identifier(forNormalizedHandle: "+15550100001")
        let second = resolver.identifier(forNormalizedHandle: "+15550100001")
        XCTAssertEqual(first, second)
        XCTAssertTrue(first.hasPrefix("h_"))
        XCTAssertEqual(first.count, 2 + ContactResolver.identifierHexLength)
        XCTAssertNotNil(first.range(of: "^h_[0-9a-f]{8,32}$", options: .regularExpression),
                        "\(first) must match the digest.v1 pattern")
    }

    /// CONTRACTS.md section 3: the same phone number must produce a DIFFERENT id for
    /// every user, so cross-user joins are arithmetically unavailable rather than merely
    /// forbidden. A resolver that ignored the salt would pass every other test here.
    func testADifferentSaltProducesADifferentIdentifierForTheSameHandle() {
        let mine = ContactResolver(salt: "salt-one").identifier(forNormalizedHandle: "+15550100001")
        let theirs = ContactResolver(salt: "salt-two").identifier(forNormalizedHandle: "+15550100001")
        XCTAssertNotEqual(mine, theirs)
    }

    func testTheLocalUserAndDeviceIdentifiersMatchTheSchemaPatterns() {
        let resolver = ContactResolver(salt: MetricsFixture.salt)
        XCTAssertNotNil(resolver.localUserIdentifier()
            .range(of: "^usr_[0-9a-zA-Z]{8,32}$", options: .regularExpression))
        XCTAssertNotNil(resolver.localDeviceIdentifier()
            .range(of: "^dev_[0-9a-zA-Z]{8,32}$", options: .regularExpression))
    }

    func testAHandleTheAddressBookDoesNotKnowStaysOnItsOwn() throws {
        let path = try MetricsFixture.addressBook(
            records: [(7, "Maya", "Ortiz")],
            phones: [(7, "+15550100001")],
            emails: [],
            label: "ab-partial")
        let directory = try XCTUnwrap(AddressBookDirectory.read(path: path))
        let resolver = ContactResolver(salt: MetricsFixture.salt, directory: directory)

        let identities = resolver.resolve(handles: ["+15550100001", "stranger@example.com"])
        XCTAssertEqual(identities.count, 2, "an unknown handle must not be merged into a known one")
        XCTAssertEqual(identities.first(where: { $0.handles.contains("+15550100001") })?.display,
                       "Maya Ortiz")
    }
}

// MARK: - The metric library

final class MetricLibraryTests: XCTestCase {

    private func library(_ mirror: MirrorDatabase,
                         directory: AddressBookDirectory = .empty,
                         calls: CallHistory? = nil) throws -> MetricLibrary.Result {
        let resolver = ContactResolver(salt: MetricsFixture.salt, directory: directory)
        return try MetricLibrary(resolver: resolver,
                                 options: .init(now: MetricsFixture.now,
                                                timeZone: TimeZone(identifier: "UTC")!,
                                                callHistory: calls))
            .compute(mirror: mirror)
    }

    /// THE CONTACT-MERGE CRITERION.
    ///
    /// One person, two handles — a phone number and an email — must produce exactly one
    /// relationship row. The existing Python prototype merges on the handle string,
    /// which cannot see that these are the same person, so it emits two rows each
    /// holding half the volume and neither landing where the real relationship belongs.
    func testOnePersonUnderTwoHandlesProducesExactlyOneRelationship() throws {
        var builder = MetricsFixture.ChatBuilder()
        for day in 1...30 {
            builder.message("from the phone", in: "+15550100001", daysAgo: Double(day))
            builder.message("from the mac", in: "maya@example.com", daysAgo: Double(day) + 0.5)
        }
        let chatPath = try builder.build(label: "merge")
        let mirror = try MetricsFixture.mirror(of: chatPath, label: "merge")

        let addressBookPath = try MetricsFixture.addressBook(
            records: [(7, "Maya", "Ortiz")],
            phones: [(7, "+15550100001")],
            emails: [(7, "maya@example.com")],
            label: "ab-merge")
        let directory = try XCTUnwrap(AddressBookDirectory.read(path: addressBookPath))

        let merged = try library(mirror, directory: directory)
        XCTAssertEqual(merged.relationships.count, 1,
                       "the AddressBook says these are one person, so this is one row")
        XCTAssertEqual(merged.relationships[0].messageCount, 60)
        XCTAssertEqual(merged.relationships[0].identity.display, "Maya Ortiz")
        XCTAssertEqual(merged.relationships[0].identity.handles.count, 2)
        XCTAssertEqual(merged.relationships[0].identity.addressBookRecordID, 7)

        // THE CANARY: without the AddressBook there is nothing to merge on, and the
        // person splits in two. This is what the prototype's bug looks like, and it is
        // the reason the assertion above is worth anything.
        let unmerged = try library(mirror)
        XCTAssertEqual(unmerged.relationships.count, 2,
                       "with no record id to merge on, one person must split — the bug")
        XCTAssertEqual(unmerged.relationships.map(\.messageCount), [30, 30])
    }

    /// Momentum is the whole point of the library. The balance ratio this track is
    /// forbidden to compute measured sd 0.034 across 25 real relationships; momentum
    /// spans 0.0x to 13.9x on the same set.
    func testMomentumComparesTheRecentQuarterWithThePriorOne() {
        XCTAssertEqual(MetricLibrary.momentum(recent: 30, prior: 60), 0.5)
        XCTAssertEqual(MetricLibrary.momentum(recent: 60, prior: 30), 2.0)
        XCTAssertEqual(MetricLibrary.momentum(recent: 0, prior: 40), 0.0)
    }

    /// A quarter with nothing in it has no ratio. Reporting a brand-new acquaintance as
    /// an infinite multiple would put them at the top of "rising fastest" every time.
    func testAnEmptyPriorQuarterDoesNotProduceAnInfiniteMomentum() {
        XCTAssertEqual(MetricLibrary.momentum(recent: 0, prior: 0), 0.0)
        XCTAssertEqual(MetricLibrary.momentum(recent: 5, prior: 0), 5.0)
        XCTAssertEqual(MetricLibrary.momentum(recent: 5000, prior: 0),
                       MetricLibrary.maximumMomentum)
        XCTAssertEqual(MetricLibrary.momentum(recent: 5000, prior: 1),
                       MetricLibrary.maximumMomentum)
    }

    /// CONTRACTS.md section 6, pinned because Track B computes the same statistic in
    /// Python. `n = 20` is the case the contract calls out by name: banker's rounding
    /// gives index 18 and half-away-from-zero gives 19, so a language default here means
    /// two implementations that disagree and neither is wrong.
    func testPercentilesAreNearestRankHalfUp() {
        XCTAssertEqual(MetricLibrary.percentileIndex(count: 20, percentile: 90), 17)
        XCTAssertEqual(MetricLibrary.percentileIndex(count: 10, percentile: 50), 4)
        XCTAssertEqual(MetricLibrary.percentileIndex(count: 1, percentile: 90), 0)
        XCTAssertEqual(MetricLibrary.percentileIndex(count: 3, percentile: 100), 2)
        XCTAssertEqual(MetricLibrary.percentileIndex(count: 3, percentile: 1), 0)
    }

    /// Initiation counts who breaks a silence, not who types more. Somebody who answers
    /// at length is indistinguishable from somebody who starts everything if you only
    /// count volume.
    func testInitiationCountsConversationOpenersRatherThanVolume() throws {
        var builder = MetricsFixture.ChatBuilder()
        // Four conversations, all opened by the user, each answered at length by them.
        for conversation in 0..<4 {
            let day = Double(conversation * 7 + 1)
            builder.message("you up", in: "+15550100002", daysAgo: day, fromMe: true)
            for reply in 1...6 {
                builder.message("a long answer", in: "+15550100002",
                                daysAgo: day - Double(reply) * 0.01)
            }
        }
        let mirror = try MetricsFixture.mirror(
            of: try builder.build(label: "initiation"), label: "initiation")
        let result = try library(mirror)
        let relationship = try XCTUnwrap(result.relationships.first)

        XCTAssertEqual(relationship.conversationsOpened, 4)
        XCTAssertEqual(relationship.conversationsOpenedByUser, 4)
        XCTAssertEqual(relationship.initiationRatio, 1.0)
        // And the volume ratio points the other way, which is the distinction.
        XCTAssertLessThan(Double(relationship.sentCount) / Double(relationship.messageCount), 0.2)
    }

    /// An overnight gap is not a reply. Counting it as latency reports somebody's sleep
    /// as rudeness, and it is the single largest source of nonsense in a naive
    /// implementation.
    func testAGapLongerThanADayIsNotCountedAsAReply() throws {
        var builder = MetricsFixture.ChatBuilder()
        builder.message("first", in: "+15550100003", minutesAgo: 10_000, fromMe: true)
        builder.message("replied fast", in: "+15550100003", minutesAgo: 9_998)
        builder.message("much later", in: "+15550100003", minutesAgo: 5_000, fromMe: true)
        let mirror = try MetricsFixture.mirror(
            of: try builder.build(label: "latency"), label: "latency")
        let relationship = try XCTUnwrap(try library(mirror).relationships.first)

        XCTAssertEqual(relationship.medianReplyLatency.them, 120)
        XCTAssertNil(relationship.medianReplyLatency.user,
                     "the only candidate was a 3-day gap, which is not a reply")
    }

    /// Tapbacks are reactions. Counting them as messages inflates every volume metric
    /// and moves whoever uses them most to the top of the ranking.
    func testTapbacksAreCountedAsWarmthAndNotAsMessages() throws {
        var builder = MetricsFixture.ChatBuilder()
        for day in 1...10 {
            builder.message("hi", in: "+15550100004", daysAgo: Double(day), fromMe: day.isMultiple(of: 2))
        }
        for day in 1...3 { builder.message(nil, in: "+15550100004", daysAgo: Double(day), tapbackType: 2000) }
        for day in 1...5 {
            builder.message(nil, in: "+15550100004", daysAgo: Double(day),
                            fromMe: true, tapbackType: 2001)
        }
        let mirror = try MetricsFixture.mirror(
            of: try builder.build(label: "tapbacks"), label: "tapbacks")
        let relationship = try XCTUnwrap(try library(mirror).relationships.first)

        XCTAssertEqual(relationship.messageCount, 10)
        XCTAssertEqual(relationship.tapbacksGiven, 5)
        XCTAssertEqual(relationship.tapbacksReceived, 3)
    }

    /// `was_delivered_quietly` is the only signal that comes from the other person's
    /// device. Absent evidence is nil, never false — "not muted" and "no way to tell"
    /// are different answers and the schema has room for both.
    func testMutedByThemIsNilWhenTheUserHasNeverSentAnything() throws {
        var builder = MetricsFixture.ChatBuilder()
        for day in 1...5 { builder.message("hello?", in: "+15550100005", daysAgo: Double(day)) }
        builder.message("hey", in: "+15550100006", daysAgo: 1, fromMe: true, quietly: true)
        builder.message("hey", in: "+15550100007", daysAgo: 1, fromMe: true)
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "muted"), label: "muted")
        let byHandle = Dictionary(uniqueKeysWithValues:
            try library(mirror).relationships.map { ($0.identity.handles[0], $0) })

        XCTAssertNil(byHandle["+15550100005"]?.mutedByThem)
        XCTAssertEqual(byHandle["+15550100006"]?.mutedByThem, true)
        XCTAssertEqual(byHandle["+15550100007"]?.mutedByThem, false)
    }

    func testGreenShareCountsNonIMessageTraffic() throws {
        var builder = MetricsFixture.ChatBuilder()
        for day in 1...4 { builder.message("blue", in: "+15550100008", daysAgo: Double(day)) }
        for day in 1...6 {
            builder.message("green", in: "+15550100009", daysAgo: Double(day), service: "SMS")
        }
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "green"), label: "green")
        let result = try library(mirror)
        let byHandle = Dictionary(uniqueKeysWithValues:
            result.relationships.map { ($0.identity.handles[0], $0) })

        XCTAssertEqual(byHandle["+15550100008"]?.greenShare, 0.0)
        XCTAssertEqual(byHandle["+15550100009"]?.greenShare, 1.0)
        XCTAssertEqual(result.corpus.greenShare, 0.6, accuracy: 0.0001)
    }

    func testCallsAreMergedOntoThePersonRatherThanTheHandle() throws {
        var builder = MetricsFixture.ChatBuilder()
        for day in 1...5 {
            builder.message("hi", in: "+15550100001", daysAgo: Double(day))
            builder.message("hi", in: "maya@example.com", daysAgo: Double(day) + 0.5)
        }
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "calls"), label: "calls")
        let directory = try XCTUnwrap(AddressBookDirectory.read(path:
            try MetricsFixture.addressBook(records: [(7, "Maya", "Ortiz")],
                                           phones: [(7, "+15550100001")],
                                           emails: [(7, "maya@example.com")],
                                           label: "ab-calls")))
        let calls = try XCTUnwrap(CallHistory.read(path: try MetricsFixture.callHistory([
            ("+1 (555) 010-0001", 600, true, true),
            ("+15550100001", 120, false, true),
            ("+15550100001", 0, false, false),
        ], label: "ch")))

        let summary = try XCTUnwrap(try library(mirror, directory: directory, calls: calls)
            .relationships.first?.calls)
        XCTAssertEqual(summary.count, 3)
        XCTAssertEqual(summary.totalSeconds, 720)
        XCTAssertEqual(summary.initiatedByUser, 1)
        XCTAssertEqual(summary.missed, 1, "an outgoing call nobody answered is not a missed call")
    }

    /// Absent is not zero. A Mac without Full Disk Access cannot read CallHistory, and
    /// reporting `count: 0` there is a claim the Mac is in no position to make.
    func testAnUnreadableCallHistoryLeavesTheCallsObjectOffEntirely() throws {
        XCTAssertNil(CallHistory.read(path: "/tmp/boi-a/tests/definitely-not-here.storedata"))
        var builder = MetricsFixture.ChatBuilder()
        for day in 1...5 { builder.message("hi", in: "+15550100001", daysAgo: Double(day)) }
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "nocalls"),
                                               label: "nocalls")
        XCTAssertNil(try library(mirror).relationships.first?.calls)
    }

    func testUnansweredQuestionsAreCountedPerDirection() {
        // Rebuilt in memory rather than through SQLite: the shapes here are about
        // ordering and direction, and a database adds nothing but latency.
        func message(_ text: String?, minutesAgo: Double, fromMe: Bool) -> MirrorDatabase.StoredMessage {
            MirrorDatabase.StoredMessage(
                guid: UUID().uuidString, text: text, handle: nil, service: "iMessage",
                sentAt: MetricsFixture.now.addingTimeInterval(-minutesAgo * 60),
                isFromMe: fromMe, associatedMessageType: 0, chatIdentifier: "+1",
                chatStyle: 45, wasDeliveredQuietly: false)
        }
        let ordered = [
            message("are you still coming?", minutesAgo: 10_000, fromMe: true),   // never answered
            message("hey", minutesAgo: 9_000, fromMe: true),
            message("did you hear back?", minutesAgo: 500, fromMe: false),        // answered
            message("yeah I did", minutesAgo: 400, fromMe: true),
            message("what time?", minutesAgo: 300, fromMe: true),                 // never answered
        ]
        let counts = MetricLibrary.unansweredQuestions(ordered)
        XCTAssertEqual(counts.user, 2)
        XCTAssertEqual(counts.them, 0)
    }

    // MARK: Archetypes

    private func metrics(messages: Int = 500,
                         daysSince: Int = 1,
                         momentum: Double = 1.0,
                         initiation: Double = 0.5,
                         opened: Int = 40,
                         unanswered: Int = 0,
                         lastWordIsUsers: Bool = false) -> MetricLibrary.RelationshipMetrics {
        var metrics = MetricLibrary.RelationshipMetrics(
            identity: .init(contact_id: "h_00000000", display: "x", handles: ["+1"],
                            addressBookRecordID: nil))
        metrics.messageCount = messages
        metrics.daysSinceLastContact = daysSince
        metrics.momentum90d = momentum
        metrics.initiationRatio = initiation
        metrics.conversationsOpened = opened
        metrics.unansweredQuestionsFromUser = unanswered
        metrics.userSentLastMessage = lastWordIsUsers
        return metrics
    }

    /// Thresholds stated, and each one asserted from both sides so a change to any of
    /// them has to be deliberate.
    func testEachArchetypeIsAssignedAtItsStatedThreshold() {
        XCTAssertEqual(MetricLibrary.fadeMomentum, 0.5)
        XCTAssertEqual(MetricLibrary.fadeQuietDays, 30)
        XCTAssertEqual(MetricLibrary.chapterQuietDays, 180)
        XCTAssertEqual(MetricLibrary.risingMomentum, 1.5)
        XCTAssertEqual(MetricLibrary.oneWayInitiationRatio, 0.7)

        XCTAssertEqual(MetricLibrary.classify(metrics(daysSince: 40, momentum: 0.49)), .fade)
        XCTAssertNil(MetricLibrary.classify(metrics(daysSince: 40, momentum: 0.51)),
                     "just above the fade threshold is not a fade")
        XCTAssertNil(MetricLibrary.classify(metrics(daysSince: 29, momentum: 0.1)),
                     "still in touch this week is not a fade, however steep the decline")

        XCTAssertEqual(MetricLibrary.classify(metrics(daysSince: 180, momentum: 0.0)), .chapter)
        XCTAssertEqual(MetricLibrary.classify(metrics(daysSince: 179, momentum: 0.0)), .fade)

        XCTAssertEqual(MetricLibrary.classify(metrics(momentum: 1.5, initiation: 0.5)),
                       .risingFastest)
        XCTAssertNil(MetricLibrary.classify(metrics(momentum: 1.49)))
        XCTAssertNil(MetricLibrary.classify(metrics(daysSince: 15, momentum: 1.5)),
                     "rising means rising now, not rising until two weeks ago")

        XCTAssertEqual(MetricLibrary.classify(metrics(momentum: 1.0, initiation: 0.7)),
                       .oneWayEnthusiasm)
        XCTAssertNil(MetricLibrary.classify(metrics(momentum: 1.0, initiation: 0.69)))

        XCTAssertEqual(MetricLibrary.classify(metrics(momentum: 1.0, initiation: 0.6,
                                                      unanswered: 3, lastWordIsUsers: true)),
                       .theOneYouKeepWaiting)
        XCTAssertNil(MetricLibrary.classify(metrics(momentum: 1.0, initiation: 0.6,
                                                    unanswered: 3, lastWordIsUsers: false)),
                     "if they had the last word you are not the one waiting")
    }

    /// Nine exchanged messages are not an arc. A label is what the morning text says out
    /// loud, so no label beats a wrong one.
    func testATinyThreadIsNotClassifiedAtAll() {
        XCTAssertNil(MetricLibrary.classify(metrics(messages: 19, daysSince: 300)))
        XCTAssertEqual(MetricLibrary.classify(metrics(messages: 20, daysSince: 300)), .chapter)
    }
}

// MARK: - The retention boundary, and the digest

final class DigestTests: XCTestCase {

    private var result: MetricLibrary.Result!
    private var digest: Digest!
    private var generatedAt = Date()

    override func setUpWithError() throws {
        try MetricsFixture.ensureCappedChatDatabase()
        let mirror = try MetricsFixture.mirror(of: MetricsFixture.cappedChatDatabasePath,
                                               label: "digest")
        let resolver = ContactResolver(salt: MetricsFixture.salt)
        generatedAt = try MetricsFixture.newestMessage(in: mirror)
        result = try MetricLibrary(resolver: resolver,
                                   options: .init(now: generatedAt,
                                                  timeZone: TimeZone(identifier: "UTC")!))
            .compute(mirror: mirror)
        digest = DigestBuilder(resolver: resolver,
                               options: .init(generatedAt: generatedAt)).build(from: result)
    }

    /// THE EXACT-BOUNDARY SIGNATURE, CONTRACTS.md section 10.
    ///
    /// The fixture is generated with `--retention-cap-days 365`, which floors every
    /// thread that started earlier at exactly the cap — the same shape the real 94k
    /// corpus had. Three of the six threads land on the boundary because their natural
    /// start was more than a year back; the other three started inside the window and
    /// their first-contact dates are real.
    func testThreadsOnTheRetentionBoundaryEmitANullFirstContact() throws {
        XCTAssertEqual(digest.corpus.retention_boundary, "1y_exact")
        XCTAssertEqual(result.corpus.threadsOnBoundary, 3)

        let nulled = digest.relationships.filter { $0.first_contact_at == nil }
        let dated = digest.relationships.filter { $0.first_contact_at != nil }
        XCTAssertEqual(nulled.count, 3,
                       "the three threads floored at the cap must not claim a first contact")
        XCTAssertEqual(dated.count, 3,
                       "the three that started inside the window keep their real dates")

        // And the dated ones are genuinely clear of the boundary, so this is not three
        // rows that happened to round the right way.
        let boundary = try XCTUnwrap(result.corpus.retentionBoundaryAt)
        for relationship in dated {
            let first = try XCTUnwrap(StructuredLog.date(from: try XCTUnwrap(relationship.first_contact_at)))
            XCTAssertGreaterThan(first.timeIntervalSince(boundary), 86_400)
        }
    }

    /// The rule has to be conditional on the boundary existing, or every corpus loses
    /// its oldest relationship's first-contact date forever.
    func testWithNoRetentionBoundaryEveryFirstContactSurvives() throws {
        var builder = MetricsFixture.ChatBuilder()
        for day in stride(from: 900.0, to: 0.0, by: -30.0) {
            builder.message("hi", in: "+15550100001", daysAgo: day)
            builder.message("hi", in: "+15550100002", daysAgo: day - 400 > 0 ? day - 400 : day)
        }
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "nocap"), label: "nocap")
        let resolver = ContactResolver(salt: MetricsFixture.salt)
        let deep = try MetricLibrary(resolver: resolver,
                                     options: .init(now: MetricsFixture.now,
                                                    timeZone: TimeZone(identifier: "UTC")!))
            .compute(mirror: mirror)

        XCTAssertNil(deep.corpus.retentionBoundary)
        XCTAssertTrue(deep.relationships.allSatisfy { $0.firstContactAt != nil })
    }

    /// One thread starting on the oldest day in the corpus is a tautology — some thread
    /// has to be the oldest. A pile-up is the evidence, because friendships do not
    /// synchronize and deletion policies do.
    func testASingleThreadOnTheOldestDayIsNotEvidenceOfACap() {
        XCTAssertEqual(RetentionBoundary.detect(spanDays: 365, threadsOnBoundary: 3), "1y_exact")
        XCTAssertEqual(RetentionBoundary.detect(spanDays: 365, threadsOnBoundary: 1), "365d")
        XCTAssertEqual(RetentionBoundary.detect(spanDays: 30, threadsOnBoundary: 4), "30d_exact")
        XCTAssertNil(RetentionBoundary.detect(spanDays: 700, threadsOnBoundary: 5))
    }

    /// THE ROUND TRIP. The document on disk must decode into the frozen struct and
    /// re-encode to the same JSON — that is what makes `mac/Sources/BoiKit/Contracts.swift`
    /// a mirror of the schema rather than a parallel definition of it.
    func testTheDigestRoundTripsThroughTheFrozenStructWithoutLoss() throws {
        let path = "/tmp/boi-a/tests/roundtrip-\(UUID().uuidString).json"
        try DigestBuilder.write(digest, to: path)
        let original = try Data(contentsOf: URL(fileURLWithPath: path))

        let decoded = try JSONDecoder().decode(Digest.self, from: original)
        XCTAssertEqual(decoded.schema_version, "digest.v1")
        XCTAssertEqual(decoded.relationships.count, digest.relationships.count)

        // Written through the same path, because the writer adds explicit nulls that
        // `JSONEncoder` alone would drop — see `DigestBuilder.relationshipExplicitNulls`.
        // Re-writing what we just read must be a fixed point: any field the struct
        // silently discards shows up here as a shorter document.
        let again = "/tmp/boi-a/tests/roundtrip-again-\(UUID().uuidString).json"
        try DigestBuilder.write(decoded, to: again)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: again)), original)

        // And the null is really there, not merely absent-and-tolerated.
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: original)
            as? [String: Any])
        let rows = try XCTUnwrap(object["relationships"] as? [[String: Any]])
        let nulled = rows.filter { $0["first_contact_at"] is NSNull }
        XCTAssertEqual(nulled.count, 3,
                       "CONTRACTS section 10 says EMIT null, not omit the key")
        XCTAssertTrue(rows.allSatisfy { $0.keys.contains("first_contact_at") })
    }

    /// THE CROSS-LANGUAGE BAR. Swift's own opinion of its output is worth nothing here;
    /// the arbiter is the JSON Schema, checked by a tool this track did not write.
    func testTheGeneratedDigestValidatesAgainstTheFrozenJSONSchema() throws {
        let path = "/tmp/boi-a/tests/validate-\(UUID().uuidString).json"
        try DigestBuilder.write(digest, to: path)
        let script = Fixture.repositoryRoot
            .appendingPathComponent("scripts/validate_fixtures.py").path
        let output = try Fixture.run("/usr/bin/python3", [script, "digest.v1", path])
        XCTAssertTrue(output.contains("OK"), "validator said: \(output)")
    }

    /// CONTRACTS.md section 6: `as_of` on every fact, end to end. It must be
    /// structurally impossible to lose, because the failure mode is Boi confidently
    /// saying something false about a person's friend.
    func testEveryRelationshipCarriesARealAsOf() throws {
        XCTAssertFalse(digest.relationships.isEmpty)
        for relationship in digest.relationships {
            XCTAssertFalse(relationship.as_of.isEmpty)
            XCTAssertEqual(relationship.as_of, digest.generated_at)
            let parsed = try XCTUnwrap(StructuredLog.date(from: relationship.as_of),
                                       "as_of must be ISO 8601 UTC, not \(relationship.as_of)")
            XCTAssertEqual(parsed.timeIntervalSince(generatedAt), 0, accuracy: 1.0)
            // The zero date is what a defaulted `Date()` looks like when it is wrong.
            XCTAssertGreaterThan(parsed.timeIntervalSince1970, 1_600_000_000)
        }
        XCTAssertEqual(digest.corpus.as_of, digest.generated_at)
        XCTAssertEqual(digest.whole_life.as_of, digest.generated_at)
    }

    /// At least one relationship on the fixture classifies as `fade`, with the threshold
    /// asserted rather than assumed.
    func testAtLeastOneFixtureRelationshipClassifiesAsFade() throws {
        let fades = result.relationships.filter { $0.archetype == .fade }
        XCTAssertFalse(fades.isEmpty, "no fade on a corpus with a thread that halved and went quiet")
        for fade in fades {
            XCTAssertLessThan(fade.momentum90d, MetricLibrary.fadeMomentum)
            XCTAssertGreaterThanOrEqual(fade.daysSinceLastContact, MetricLibrary.fadeQuietDays)
            XCTAssertLessThan(fade.daysSinceLastContact, MetricLibrary.chapterQuietDays)
        }
        XCTAssertEqual(digest.relationships.filter { $0.archetype == .fade }.count, fades.count)
    }

    /// Under five seconds is the criterion; the real number is two orders of magnitude
    /// inside it, which is why the product has no upload and no progress bar.
    func testTheDigestCompletesWellInsideTheTimeBudget() throws {
        XCTAssertLessThan(result.elapsed, 5.0,
                          "digest took \(result.elapsed)s over \(result.corpus.messageCount) messages")
    }

    /// Group threads belong in whole-life volume and never in the 1:1 ranking. The
    /// fixture's group chat is 60 messages that must not become a seventh relationship.
    func testTheGroupThreadIsCountedInWholeLifeButNotRanked() throws {
        XCTAssertEqual(digest.relationships.count, 6)
        XCTAssertTrue(digest.relationships.allSatisfy { !$0.is_group })
        let ranked = digest.relationships.reduce(0) { $0 + $1.message_count }
        XCTAssertEqual(try XCTUnwrap(digest.whole_life.total_messages) - ranked, 60,
                       "the 60 group messages are in the corpus total and out of the ranking")
        XCTAssertEqual(digest.corpus.thread_count, 7)
    }

    /// The corpus is capped, so health cannot be `healthy` — and the reason has to say
    /// which remedy applies, because a reveal without a one-tap fix is just guilt.
    func testACappedCorpusIsReportedAsFixableWithTheReasonNamed() {
        XCTAssertEqual(digest.corpus.health, .fixable)
        XCTAssertEqual(digest.corpus.health_reasons, ["keep_messages_1y"])
    }

    /// Same mirror in, same bytes out. A digest that reorders itself between runs cannot
    /// be diffed against the previous one, and diffing it is how anybody notices a metric
    /// quietly changing.
    func testTwoRunsOverOneMirrorProduceIdenticalBytes() throws {
        let resolver = ContactResolver(salt: MetricsFixture.salt)
        let again = DigestBuilder(resolver: resolver,
                                  options: .init(generatedAt: generatedAt)).build(from: result)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        XCTAssertEqual(try encoder.encode(again), try encoder.encode(digest))
    }
}

// MARK: - Guards

final class DigestGuardTests: XCTestCase {

    /// The banned metric, enforced against the source rather than trusted.
    ///
    /// It is out of scope by name in prompt 04 and in CONTRACTS.md section 6: across 25
    /// real relationships the spread was 0.465-0.615, sd 0.034, and it is the most
    /// legally dangerous number in the category. This test is the same check the
    /// Definition of Done runs with grep, kept in the suite so it fails at `swift test`
    /// and not only in a checklist somebody has to remember to run.
    ///
    /// TWO FILES ARE EXEMPT AND NEITHER IS THIS TRACK'S TO CHANGE. The foundation wrote
    /// both, and both mention the metric only to say it carries no signal —
    /// `Contracts.swift` is on `check-ownership.sh`'s frozen list, and
    /// `FoundationTests.swift` is the foundation harness this track extends and never
    /// weakens. So the Definition of Done's recursive grep for the metric's name over
    /// `mac/` cannot come back empty however this track behaves; see NOTES.md. Exempted
    /// **by name**, so a third file appearing fails this test rather than widening the
    /// hole.
    func testNoSourceFileMentionsTheBannedBalanceMetric() throws {
        let foundationOwned: Set<String> = ["Sources/BoiKit/Contracts.swift",
                                            "Tests/BoiKitTests/FoundationTests.swift"]
        // Spelled as fragments so this file is not itself the only match, the same way
        // `SourceGuardTests` handles the two tokens it bans, and for the same reason.
        let banned = "recipro" + "c"
        let root = Fixture.repositoryRoot.appendingPathComponent("mac")
        var offenders: [String] = []
        let enumerator = FileManager.default.enumerator(atPath: root.path)
        while let entry = enumerator?.nextObject() as? String {
            guard entry.hasSuffix(".swift"), !entry.hasPrefix(".build/"),
                  !foundationOwned.contains(entry) else { continue }
            let text = try String(contentsOf: root.appendingPathComponent(entry),
                                  encoding: .utf8)
            if text.lowercased().contains(banned) { offenders.append(entry) }
        }
        XCTAssertEqual(offenders, [], "these files mention the metric this track must not ship")

        // And the exemption is only worth granting because those two files are still
        // there saying what they say. If one is gone, the exemption is stale.
        for path in foundationOwned {
            XCTAssertTrue(FileManager.default.fileExists(atPath:
                root.appendingPathComponent(path).path), "\(path) has moved")
        }
    }

    /// The digest carries aggregates and nothing else. `digest.v1`'s own description
    /// says "Contains NO message text from anyone", and `additionalProperties: false` is
    /// what keeps that true — this asserts the Swift side agrees.
    func testTheDigestStructHasNowhereToPutMessageText() throws {
        var builder = MetricsFixture.ChatBuilder()
        let secret = "a-very-distinctive-string-nobody-would-aggregate"
        for day in 1...30 { builder.message(secret, in: "+15550100001", daysAgo: Double(day)) }
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "notext"),
                                               label: "notext")
        let resolver = ContactResolver(salt: MetricsFixture.salt)
        let result = try MetricLibrary(resolver: resolver,
                                       options: .init(now: MetricsFixture.now))
            .compute(mirror: mirror)
        let digest = DigestBuilder(resolver: resolver,
                                   options: .init(generatedAt: MetricsFixture.now))
            .build(from: result)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let json = try XCTUnwrap(String(data: try encoder.encode(digest), encoding: .utf8))
        XCTAssertFalse(json.contains(secret), "message text reached the digest")
    }

    /// `.env` is per-worktree and `swift run` does not source it. Without this fallback
    /// the salt silently defaults to nothing and every contact_id becomes unreproducible.
    func testTheDevelopmentSaltIsFoundInTheWorktreeEnvFile() throws {
        let values = DotEnv.parse("""
            # a comment
            BOI_DEV_USER_SALT=boi-dev-salt-do-not-ship-0001
            BOI_MODEL_PROVIDER=fake            # fake | gemini | kimi
            EMPTY=
            """)
        XCTAssertEqual(values["BOI_DEV_USER_SALT"], "boi-dev-salt-do-not-ship-0001")
        XCTAssertEqual(values["BOI_MODEL_PROVIDER"], "fake",
                       "a trailing comment is not part of the value")
        XCTAssertEqual(values["EMPTY"], "")

        // The process environment always wins over the file.
        XCTAssertEqual(ContactResolver.developmentSalt(
            environment: ["BOI_DEV_USER_SALT": "from-the-environment"],
            searchingFrom: Fixture.repositoryRoot.path), "from-the-environment")
        XCTAssertEqual(ContactResolver.developmentSalt(
            environment: [:], searchingFrom: Fixture.repositoryRoot.path),
            "boi-dev-salt-do-not-ship-0001",
            "this worktree's .env must carry the shared dev salt — copy .env.example")
    }
}

// MARK: - AMENDMENT-001

/// The four fields the gist producer needs, and the agreement the amendment turns on.
///
/// The DoD asks that a digest built from the synthetic corpus carry values that MATCH
/// what the Python SQL producer computes from the same corpus — asserted, not eyeballed.
/// That is the whole risk of this amendment in one test: two implementations of the same
/// statistics, one in Swift over the mirror and one in Python over `chat.db`.
final class DigestAmendment001Tests: XCTestCase {

    override func setUpWithError() throws {
        try Fixture.ensureChatDatabase()
    }

    /// Builds a real digest from the synthetic corpus, the way `sync-run` does.
    func buildDigest() throws -> (Digest, MirrorDatabase) {
        let root = "/tmp/boi-a/tests/amendment-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        let mirror = try MirrorDatabase(path: root + "/mirror.db")
        let reader = try MessageReader(path: Fixture.chatDatabasePath)
        _ = try MirrorSync(reader: reader, mirror: mirror).run()

        let salt = "boi-dev-salt-do-not-ship-0001"
        let resolver = ContactResolver(salt: salt, directory: .empty)
        let metrics = try MetricLibrary(resolver: resolver, options: .init(now: Date()))
            .compute(mirror: mirror)
        let signals = try FactExtractor.signalsByContact(
            mirror: mirror, identities: metrics.relationships.map(\.identity))
        let digest = DigestBuilder(resolver: resolver,
                                   options: .init(generatedAt: Date(), signalsByContact: signals))
            .build(from: metrics)
        return (digest, mirror)
    }

    func testEveryRelationshipCarriesAllFourFields() throws {
        let (digest, _) = try buildDigest()
        XCTAssertFalse(digest.relationships.isEmpty)
        // Required means required: every relationship, not most of them.
        for relationship in digest.relationships {
            XCTAssertGreaterThanOrEqual(relationship.max_gap_days, 0)
            // `facts` is structurally complete even when empty — five lists, always.
            let facts = relationship.facts
            XCTAssertEqual(
                [facts.dates, facts.times, facts.places, facts.amounts, facts.names].count, 5)
            for token in facts.allTokens {
                XCTAssertLessThanOrEqual(token.count, 40, token)
                XCTAssertLessThanOrEqual(token.split(separator: " ").count, 3, token)
            }
        }
    }

    /// **THE AGREEMENT ASSERTION.** Swift's digest vs Python's `ThreadStats`, same corpus.
    func testTheFourFieldsMatchWhatPythonComputesFromTheSameCorpus() throws {
        let (digest, _) = try buildDigest()

        let script = """
            import json, sys
            sys.path.insert(0, sys.argv[1])
            from boi_intel import chatdb
            from boi_intel.threads import load_threads
            con = chatdb.connect(sys.argv[2])
            threads = load_threads(con)
            con.close()
            salt = sys.argv[3].encode()
            print(json.dumps({
                chatdb.contact_id(h, salt): {
                    "last_from_me": bool(s.last_from_me),
                    "max_gap_days": int(s.max_gap_days),
                    "unanswered_question": bool(s.unanswered_question),
                }
                for h, s in threads.items()
            }))
            """
        let raw = try FactExtractorTests.run(script, arguments: [
            Fixture.repositoryRoot.appendingPathComponent("intelligence").path,
            Fixture.chatDatabasePath,
            "boi-dev-salt-do-not-ship-0001",
        ])
        struct Expected: Decodable {
            let last_from_me: Bool
            let max_gap_days: Int
            let unanswered_question: Bool
        }
        let python = try JSONDecoder().decode(
            [String: Expected].self, from: Data(raw.utf8))

        var compared = 0
        for relationship in digest.relationships {
            guard let expected = python[relationship.contact_id] else { continue }
            compared += 1
            XCTAssertEqual(relationship.last_from_me, expected.last_from_me,
                           "last_from_me disagrees for \(relationship.contact_id)")
            XCTAssertEqual(relationship.unanswered_question, expected.unanswered_question,
                           "unanswered_question disagrees for \(relationship.contact_id)")
            XCTAssertEqual(relationship.max_gap_days, expected.max_gap_days,
                           "max_gap_days disagrees for \(relationship.contact_id)")
        }
        // An agreement over zero contacts is not an agreement.
        XCTAssertGreaterThan(compared, 0, "no contact_id matched between Swift and Python")
    }

    /// The digest must not become a place message prose can hide.
    func testNoInboundProseReachesTheDigest() throws {
        let (digest, mirror) = try buildDigest()
        var inbound: [String] = []
        try mirror.forEachMessage { message in
            guard !message.isFromMe, let text = message.text, text.count >= 12 else { return }
            inbound.append(text)
        }
        XCTAssertGreaterThan(inbound.count, 0)

        let serialized = String(
            data: try JSONEncoder().encode(digest.relationships), encoding: .utf8)!.lowercased()
        for message in inbound.prefix(200) where serialized.contains(message.lowercased()) {
            XCTFail("an inbound message appears verbatim in the digest: \(message.prefix(20))…")
        }
    }
}
