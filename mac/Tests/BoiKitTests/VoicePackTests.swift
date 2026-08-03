import XCTest
@testable import BoiKit

// MARK: - Redaction

final class RedactionTests: XCTestCase {

    func testPhoneNumbersEmailsAndAmountsAreRemoved() {
        let redactor = Redactor()
        for (input, banned) in [
            ("call me at 555-010-0001 when ur free", "555-010-0001"),
            ("my new one is +1 (555) 010-0002", "555"),
            ("email me at maya.ortiz@example.com", "maya.ortiz@example.com"),
            ("it came to $120.50 total", "$120.50"),
            ("that was like 300 dollars honestly", "300 dollars"),
            ("im at 1425 Telegraph Ave rn", "1425 Telegraph Ave"),
        ] {
            let output = redactor.redact(input)
            XCTAssertFalse(output.contains(banned),
                           "\(banned.count > 0 ? banned : input) survived: \(output)")
            XCTAssertTrue(output.contains(Redactor.placeholder), "nothing was redacted in \(output)")
        }
    }

    /// CONTRACTS.md § 7: name redaction must not assume capitalization. The target
    /// corpus is lowercase texting — the fixture register is literally
    /// `lowercase_no_period` — so a pattern requiring `[A-Z]` passes every test written
    /// against capitalized samples and leaks the real thing untouched.
    func testALowercaseNameFromTheAddressBookIsStillRedacted() {
        let redactor = Redactor(knownNames: ["John Smith", "Maya Ortiz"])
        let output = redactor.redact("ill ask john smith about it")
        XCTAssertFalse(output.lowercased().contains("john"), output)
        XCTAssertFalse(output.lowercased().contains("smith"), output)
        XCTAssertTrue(output.contains(Redactor.namePlaceholder), output)

        // And a capitalized name with no AddressBook behind it is caught by shape.
        XCTAssertFalse(Redactor().redact("talked to Sarah Chen today").contains("Sarah Chen"))
    }

    /// The canary for the lowercase path specifically: with an empty directory the
    /// lowercase name survives, which is exactly the leak the § 7 correction is about.
    /// Stated as a test rather than as a comment so the limitation cannot be forgotten.
    func testWithNoContactsALowercaseNameIsNotCaughtWhichIsTheKnownLimit() {
        XCTAssertTrue(Redactor().redact("ill ask john smith about it").contains("john smith"),
                      "if this now passes, name coverage improved — widen the claim in NOTES.md")
    }

    /// A redactor that rewrote its own output would make `voice_pack_version` unstable —
    /// and worse, `containsSpecifics` is defined as "redaction would change this", so a
    /// non-idempotent redactor reports a leak on text that has nothing to leak.
    ///
    /// **The whitespace cases are here because the real corpus found them and every
    /// synthetic message missed them.** Replacing `"  "` with `" "` leaves a double
    /// space behind on a run of four, so the second pass differs from the first and the
    /// serializer refuses to write a perfectly clean pack. Runs of spaces and embedded
    /// newlines are ordinary in real messages and absent from every hand-written one.
    func testRedactionIsIdempotentIncludingOnWhitespaceRuns() {
        let redactor = Redactor(knownNames: ["Maya Ortiz"])
        for input in ["maya ortiz owes me $40, text her at 555-010-0001",
                      "four    spaces here",
                      "five     spaces here",
                      "a\nnewline\nand   spaces",
                      "trailing   ",
                      "\t\ttabs\t\there",
                      "ok that works for me"] {
            let once = redactor.redact(input)
            XCTAssertEqual(redactor.redact(once), once, "not idempotent on \(input.debugDescription)")
            XCTAssertFalse(redactor.containsSpecifics(once),
                           "\(once.debugDescription) reports a leak after redaction")
        }
    }

    func testOrdinaryTextIsLeftAlone() {
        let redactor = Redactor(knownNames: ["Maya Ortiz"])
        for line in ["sorry been mia this week, work has been insane",
                     "lmk when ur free and ill come thru",
                     "ok that works for me"] {
            XCTAssertEqual(redactor.redact(line), line)
        }
    }
}

// MARK: - The voice pack

final class VoicePackTests: XCTestCase {

    private static let distinctInbound = "zzq-inbound-canary-nobody-would-ever-type-this"

    /// A mirror where the user and the other person both wrote plenty, and the other
    /// person's messages carry a string that could not occur by accident.
    private func mixedMirror(label: String) throws -> MirrorDatabase {
        var builder = MetricsFixture.ChatBuilder()
        for day in 1...40 {
            builder.message("sorry been mia this week \(day)", in: "+15550100001",
                            daysAgo: Double(day), fromMe: true)
            builder.message(Self.distinctInbound, in: "+15550100001", daysAgo: Double(day) - 0.1)
        }
        return try MetricsFixture.mirror(of: try builder.build(label: label), label: label)
    }

    private func identities(_ handles: [String]) -> [ContactResolver.Identity] {
        ContactResolver(salt: MetricsFixture.salt).resolve(handles: handles)
    }

    private func build(_ mirror: MirrorDatabase,
                       handles: [String] = ["+15550100001"],
                       redactor: Redactor = Redactor()) throws -> [VoicePack] {
        try VoicePackBuilder(options: .init(now: MetricsFixture.now, redactor: redactor))
            .build(mirror: mirror, identities: identities(handles))
    }

    /// **THE GUARD-ONE TEST.**
    ///
    /// CONTRACTS.md § 7 was corrected on 2 Aug: only guard one can see provenance. The
    /// upload boundary is a redaction scan — four regexes cannot tell a message the user
    /// wrote from one they received, and a redacted inbound message passes it with a
    /// 202. The leak checker is a verbatim string match, so anything redaction rewrote
    /// no longer matches. **So this filter is the single point of failure and this test
    /// is its only alarm.** The canary run is recorded in NOTES.md: with
    /// `WHERE is_from_me = 1` removed, this test fails; with it restored, it passes.
    func testNoInboundMessageReachesTheExemplars() throws {
        let mirror = try mixedMirror(label: "guard-one")
        let packs = try build(mirror)
        XCTAssertFalse(packs.isEmpty)

        for pack in packs {
            for exemplar in pack.exemplars {
                XCTAssertFalse(exemplar.contains(Self.distinctInbound),
                               "an inbound message reached \(pack.scope) exemplars")
            }
            XCTAssertFalse(pack.exemplars.isEmpty, "\(pack.scope) pack has nothing to check")
        }

        // The other person's messages really are in the mirror, so the assertion above
        // is about the filter and not about an empty corpus.
        var inboundInMirror = 0
        try mirror.forEachMessage { if $0.text == Self.distinctInbound { inboundInMirror += 1 } }
        XCTAssertEqual(inboundInMirror, 40)
    }

    /// The serializer's own re-assertion. Reachable only if the SQL filter is gone, and
    /// then it must refuse rather than write the pack.
    func testTheSerializerRefusesAPackBuiltFromInboundMessages() throws {
        let inbound = MirrorDatabase.StoredMessage(
            guid: "g1", text: "not mine", handle: "+15550100001", service: "iMessage",
            sentAt: MetricsFixture.now, isFromMe: false, associatedMessageType: 0,
            chatIdentifier: "+15550100001", chatStyle: 45, wasDeliveredQuietly: false)
        let builder = VoicePackBuilder(options: .init(now: MetricsFixture.now))
        XCTAssertThrowsError(try builder.pack(from: [inbound], contactID: "h_00000000",
                                              scope: "contact")) { error in
            guard case VoicePackBuilder.Error.inboundMessageInExemplars = error else {
                return XCTFail("wrong error: \(error)")
            }
        }
    }

    func testExemplarsBuiltFromMessagesWithSpecificsCarryNoneOfThem() throws {
        var builder = MetricsFixture.ChatBuilder()
        for day in 1...12 {
            builder.message("call me at 555-010-000\(day % 10) ok", in: "+15550100001",
                            daysAgo: Double(day) * 3, fromMe: true)
            builder.message("email is person\(day)@example.com btw", in: "+15550100001",
                            daysAgo: Double(day) * 3 + 0.4, fromMe: true)
            builder.message("it was $1\(day)0 total", in: "+15550100001",
                            daysAgo: Double(day) * 3 + 0.8, fromMe: true)
        }
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "redact"),
                                               label: "redact")
        let packs = try build(mirror)
        XCTAssertFalse(packs.isEmpty)
        for pack in packs {
            XCTAssertFalse(pack.exemplars.isEmpty)
            for exemplar in pack.exemplars {
                XCTAssertNil(exemplar.range(of: #"\d{3}-\d{3}-\d{4}"#, options: .regularExpression),
                             "phone number in \(exemplar)")
                XCTAssertFalse(exemplar.contains("@example.com"), "email in \(exemplar)")
                XCTAssertNil(exemplar.range(of: #"\$\d"#, options: .regularExpression),
                             "dollar amount in \(exemplar)")
            }
        }
    }

    /// CONTRACTS.md § 7: redaction covers **every** free-text field, not just exemplars.
    /// `apology_openers` holds verbatim message prefixes, so a pack whose exemplars are
    /// spotless can still carry a specific into storage through that array.
    func testApologyOpenersAreRedactedToo() throws {
        var builder = MetricsFixture.ChatBuilder()
        for day in 1...10 {
            builder.message("sorry maya ortiz forgot", in: "+15550100001",
                            daysAgo: Double(day), fromMe: true)
        }
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "openers"),
                                               label: "openers")
        let packs = try build(mirror, redactor: Redactor(knownNames: ["Maya Ortiz"]))
        for pack in packs {
            for opener in pack.register.apology_openers ?? [] {
                XCTAssertFalse(opener.lowercased().contains("maya"), opener)
            }
        }
        // And the opener was actually extracted, so this is not vacuous.
        XCTAssertFalse(packs[0].register.apology_openers?.isEmpty ?? true)
    }

    func testNoPackExceedsFortyExemplarsOrTwoHundredCharacters() throws {
        var builder = MetricsFixture.ChatBuilder()
        // 300 distinct messages, some far longer than the cap.
        for index in 1...300 {
            let body = index.isMultiple(of: 7)
                ? String(repeating: "long ", count: 60) + "\(index)"
                : "message number \(index) about nothing in particular"
            builder.message(body, in: "+15550100001", daysAgo: Double(index) * 1.1, fromMe: true)
        }
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "caps"), label: "caps")
        for pack in try build(mirror) {
            XCTAssertEqual(pack.exemplars.count, VoicePackBuilder.maximumExemplars)
            XCTAssertEqual(pack.n_exemplars, pack.exemplars.count)
            for exemplar in pack.exemplars {
                XCTAssertLessThanOrEqual(exemplar.count, VoicePackBuilder.maximumExemplarLength)
                XCTAssertFalse(exemplar.isEmpty)
            }
        }
    }

    /// Exemplars are sampled across the time range, not taken off one end of it. Forty
    /// messages from one week describe who somebody was during one week.
    func testExemplarsSpanTheWholeTimeRange() throws {
        var builder = MetricsFixture.ChatBuilder()
        for index in 1...400 {
            builder.message("day \(index) message", in: "+15550100001",
                            daysAgo: Double(index), fromMe: true)
        }
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "span"), label: "span")
        let pack = try XCTUnwrap(try build(mirror).first { $0.scope == "contact" })
        let days = pack.exemplars.compactMap { exemplar -> Int? in
            Int(exemplar.split(separator: " ").dropFirst().first ?? "")
        }
        XCTAssertEqual(days.count, pack.exemplars.count, "parsed every exemplar")
        XCTAssertLessThan(try XCTUnwrap(days.min()), 60, "nothing from the recent end")
        XCTAssertGreaterThan(try XCTUnwrap(days.max()), 340, "nothing from the old end")
    }

    /// `voice_pack_version` invalidates the drafter's prompt cache, so it has to be a
    /// function of the pack's contents and of nothing else.
    func testTheVersionIsDeterministicAndChangesWithTheContent() throws {
        let mirror = try mixedMirror(label: "version")
        let first = try build(mirror)
        let second = try build(mirror)
        XCTAssertEqual(first.map(\.voice_pack_version), second.map(\.voice_pack_version))
        XCTAssertTrue(first.allSatisfy {
            $0.voice_pack_version.range(of: "^vp_[0-9a-f]{8,16}$", options: .regularExpression) != nil
        })

        var mutated = first[0]
        mutated.exemplars[0] += " and one more thing"
        XCTAssertNotEqual(VoicePackBuilder.version(for: mutated), first[0].voice_pack_version)

        // `as_of` is deliberately excluded: a pack whose contents did not change must
        // not invalidate the prompt cache every morning.
        var restamped = first[0]
        restamped.as_of = "2030-01-01T00:00:00Z"
        XCTAssertEqual(VoicePackBuilder.version(for: restamped), first[0].voice_pack_version)
    }

    /// CONTRACTS.md § 6 pins the canonical form because Track B hashes the same payload
    /// in Python. Sorted keys, no whitespace, non-ASCII left unescaped — emoji in
    /// `top_emoji` are why that last one is stated rather than assumed.
    func testTheCanonicalFormMatchesWhatPythonWouldProduce() {
        XCTAssertEqual(CanonicalJSON.string(.object([
            "b": .int(2), "a": .string("x"), "c": .null,
        ])), #"{"a":"x","b":2,"c":null}"#)
        XCTAssertEqual(CanonicalJSON.string(.array([.string("😭"), .string("🙏")])),
                       #"["😭","🙏"]"#)
        // Whole numbers keep their `.0`, the way Python's repr does and the way
        // JSONSerialization does not.
        XCTAssertEqual(CanonicalJSON.string(.double(1.0)), "1.0")
        XCTAssertEqual(CanonicalJSON.string(.double(0.0)), "0.0")
        XCTAssertEqual(CanonicalJSON.string(.double(0.11)), "0.11")
        // Slashes are not escaped; quotes and control characters are.
        XCTAssertEqual(CanonicalJSON.string(.string("a/b\"c\nd")), #""a/b\"c\nd""#)
    }

    /// A pack built from four messages is a caricature, not a voice.
    func testAContactBelowTheThresholdGetsNoPackAndFallsBackToGlobal() throws {
        var builder = MetricsFixture.ChatBuilder()
        for index in 1...(VoicePackBuilder.minimumSentMessagesForContactPack - 1) {
            builder.message("thin \(index)", in: "+15550100001", daysAgo: Double(index), fromMe: true)
        }
        for index in 1...20 {
            builder.message("plenty \(index)", in: "+15550100002", daysAgo: Double(index), fromMe: true)
        }
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "thin"), label: "thin")
        let packs = try build(mirror, handles: ["+15550100001", "+15550100002"])

        let thin = ContactResolver(salt: MetricsFixture.salt)
            .identifier(forNormalizedHandle: "+15550100001")
        XCTAssertFalse(packs.contains { $0.contact_id == thin },
                       "a contact under the threshold must produce no per-contact pack")
        let global = try XCTUnwrap(packs.first { $0.scope == "global" })
        XCTAssertNil(global.contact_id)
        XCTAssertFalse(global.exemplars.isEmpty, "the fallback must still have a voice")
        // The thin contact's own words are in the fallback, so they are not lost.
        XCTAssertTrue(global.exemplars.contains { $0.hasPrefix("thin ") })
    }

    /// The global pack is required and its `contact_id` must be present **as null** —
    /// the schema lists it in `required` and permits null, so an omitted key fails
    /// validation outright. `JSONEncoder` omits nil optionals, which is the bug.
    func testTheGlobalPackWritesContactIdAsAnExplicitNull() throws {
        let mirror = try mixedMirror(label: "explicit-null")
        let global = try XCTUnwrap(try build(mirror).first { $0.scope == "global" })
        let directory = "/tmp/boi-a/tests/pack-\(UUID().uuidString)"
        let path = try VoicePackBuilder.write(global, toDirectory: directory)
        XCTAssertTrue(path.hasSuffix("global_fallback.json"))

        let object = try XCTUnwrap(try JSONSerialization.jsonObject(
            with: try Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any])
        XCTAssertTrue(object.keys.contains("contact_id"))
        XCTAssertTrue(object["contact_id"] is NSNull)
    }

    // MARK: Register

    /// CONTRACTS.md § 7, the trap that makes every register test pass while the register
    /// is wrong: redacting before computing turns `"Hey Sarah how are you"` into
    /// `"[name] how are you"`, which stops counting as a greeting and flips the first
    /// character to lowercase. A sentence-case writer who opens with a name gets
    /// reported as lowercase with a third of their true greeting rate.
    func testTheRegisterIsComputedBeforeRedactionRewritesAnything() throws {
        var builder = MetricsFixture.ChatBuilder()
        for index in 1...20 {
            builder.message("Hey Sarah Chen how are you \(index)", in: "+15550100001",
                            daysAgo: Double(index), fromMe: true)
        }
        let mirror = try MetricsFixture.mirror(of: try builder.build(label: "register-order"),
                                               label: "register-order")
        let pack = try XCTUnwrap(try build(mirror, redactor: Redactor(knownNames: ["Sarah Chen"]))
            .first { $0.scope == "contact" })

        XCTAssertEqual(pack.register.punctuation, .sentenceCaseNoPeriod,
                       "redaction ran first and flipped the first character to lowercase")
        XCTAssertEqual(pack.register.greeting_rate, 1.0,
                       "redaction ran first and ate the greeting")
        // And the name really is gone from what ships.
        XCTAssertTrue(pack.exemplars.allSatisfy { !$0.contains("Sarah") })
    }

    func testPunctuationFallsBackToMixedWithoutAClearMajority() {
        XCTAssertEqual(VoicePackBuilder.punctuation(of: Array(repeating: "ok sounds good", count: 10)),
                       .lowercaseNoPeriod)
        XCTAssertEqual(VoicePackBuilder.punctuation(of: Array(repeating: "Ok sounds good.", count: 10)),
                       .sentenceCasePeriod)
        XCTAssertEqual(VoicePackBuilder.punctuation(of:
            Array(repeating: "ok sounds good", count: 5) + Array(repeating: "Ok sounds good.", count: 5)),
            .mixed)
    }

    func testTheRegisterFindsAbbreviationsBurstsAndApologyOpeners() throws {
        let bodies = ["lmk when ur free", "ngl i spaced", "sorry been mia this week",
                      "omg sorry i forgot", "ok that works", "what time tho?"]
        let base = MetricsFixture.now
        let messages = bodies.enumerated().map { offset, text in
            // Three inside one burst, then a long gap, then the rest.
            MirrorDatabase.StoredMessage(
                guid: "g\(offset)", text: text, handle: nil, service: "iMessage",
                sentAt: base.addingTimeInterval(offset < 3 ? Double(offset) * 30
                                                : Double(offset) * 7200),
                isFromMe: true, associatedMessageType: 0, chatIdentifier: "+1",
                chatStyle: 45, wasDeliveredQuietly: false)
        }
        let register = VoicePackBuilder.register(for: bodies, messages: messages)

        XCTAssertTrue(register.abbreviations?.contains("lmk") ?? false)
        XCTAssertTrue(register.abbreviations?.contains("ngl") ?? false)
        XCTAssertEqual(register.apology_openers?.sorted(),
                       ["omg sorry i", "sorry been mia"])
        XCTAssertEqual(try XCTUnwrap(register.question_rate), 1.0 / 6.0, accuracy: 0.0001)
        XCTAssertGreaterThan(register.avg_msgs_per_burst, 1.0)
        XCTAssertGreaterThanOrEqual(register.median_len_chars, 1)
    }

    /// Percentiles go through the same pinned nearest-rank half-up helper the digest
    /// uses, because Track B computes `p90_len_chars` in Python and the two are diffed.
    func testLengthPercentilesUseThePinnedNearestRankRule() {
        let bodies = (1...20).map { String(repeating: "x", count: $0) }
        let register = VoicePackBuilder.register(for: bodies, messages: [])
        XCTAssertEqual(register.median_len_chars, 10)
        XCTAssertEqual(register.p90_len_chars, 18)
    }
}
