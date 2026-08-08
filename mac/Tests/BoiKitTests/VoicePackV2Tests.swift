import XCTest
@testable import BoiKit

final class VoicePackV2Tests: XCTestCase {
    private static let canary = "ZZQ-VOICE-V2-INBOUND-PROSE-MUST-STAY-LOCAL"

    private func build(inbound: String = "are you free tonight?") throws -> [VoicePackV2] {
        var source = MetricsFixture.ChatBuilder()
        source.message(inbound + " " + Self.canary, in: "+15550100001", daysAgo: 12)
        for day in stride(from: 11, through: 3, by: -2) {
            source.message("user reply number \(day)", in: "+15550100001",
                           daysAgo: Double(day), fromMe: true)
            source.message("ordinary incoming turn", in: "+15550100001",
                           daysAgo: Double(day - 1))
        }
        source.message("Loved \"" + Self.canary + "\"", in: "+15550100001",
                       daysAgo: 2, fromMe: true, tapbackType: 2000)
        source.message("one final user line", in: "+15550100001", daysAgo: 1, fromMe: true)
        let mirror = try MetricsFixture.mirror(
            of: try source.build(label: "voice-v2"), label: "voice-v2")
        let resolver = ContactResolver(salt: MetricsFixture.salt)
        let identities = try MetricLibrary(resolver: resolver,
                                           options: .init(now: MetricsFixture.now))
            .compute(mirror: mirror).relationships.map(\.identity)
        return try VoicePackBuilder(options: .init(now: MetricsFixture.now))
            .buildV2(mirror: mirror, identities: identities)
    }

    func testV2ExemplarsAreOnlySafeUserRowsWithClosedContext() throws {
        let packs = try build()
        let contact = try XCTUnwrap(packs.first { $0.scope == "contact" })
        let encoded = try JSONEncoder().encode(contact)
        let text = try XCTUnwrap(String(data: encoded, encoding: .utf8))

        XCTAssertFalse(contact.exemplars.isEmpty)
        XCTAssertEqual(contact.n_exemplars, contact.exemplars.count)
        XCTAssertTrue(contact.exemplars.allSatisfy { !$0.text.isEmpty && $0.text.count <= 200 })
        XCTAssertFalse(text.contains(Self.canary))
        XCTAssertFalse(text.contains("Loved"))
        XCTAssertTrue(contact.exemplars.contains { $0.answered == .questionFromThem })
    }

    func testPriorUserStatementMapsToSchemaValidNone() throws {
        let packs = try build()
        let contact = try XCTUnwrap(packs.first { $0.scope == "contact" })
        let final = try XCTUnwrap(contact.exemplars.first { $0.text == "one final user line" })
        // The immediately preceding tapback is removed before turn pairing; the prior
        // ordinary inbound statement is therefore the context, never counterpart prose.
        XCTAssertEqual(final.answered, .statementFromThem)

        let mapped = VoicePackBuilder.wireAnsweredShape(.statementFromYou)
        XCTAssertEqual(mapped, .none)
    }

    func testVersionIsDeterministicAndChangesWhenOnlyContextChanges() throws {
        let question = try build(inbound: "are you free?")
        let sameQuestion = try build(inbound: "are you free?")
        let statement = try build(inbound: "sharing an update")
        let q = try XCTUnwrap(question.first { $0.scope == "contact" })
        let q2 = try XCTUnwrap(sameQuestion.first { $0.scope == "contact" })
        let s = try XCTUnwrap(statement.first { $0.scope == "contact" })

        XCTAssertEqual(q.voice_pack_version, q2.voice_pack_version)
        XCTAssertNotEqual(q.exemplars.first?.answered, s.exemplars.first?.answered)
        XCTAssertNotEqual(q.voice_pack_version, s.voice_pack_version)
    }

    func testGlobalExplicitNullAndBothPacksValidateSchema() throws {
        let packs = try build()
        let directory = "/tmp/boi-a/tests/voice-v2-\(UUID().uuidString)"
        let script = Fixture.repositoryRoot
            .appendingPathComponent("scripts/validate_fixtures.py").path

        for pack in packs {
            let path = try VoicePackBuilder.write(pack, toDirectory: directory)
            let output = try Fixture.run("/usr/bin/python3", [script, "voice_pack.v2", path])
            XCTAssertTrue(output.contains("OK"), output)
            if pack.scope == "global" {
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data)
                    as? [String: Any])
                XCTAssertTrue(object["contact_id"] is NSNull)
            }
        }
    }

    func testGlobalPackIsTimeDiverseDeduplicatedAndNotContactDominated() throws {
        var source = MetricsFixture.ChatBuilder()
        for index in 1...80 {
            for (handle, label, offset) in [
                ("+15550100001", "alpha", 0.0), ("+15550100002", "beta", 0.1)
            ] {
                let text = index.isMultiple(of: 10)
                    ? "shared duplicate" : "\(label) unique \(index)"
                source.message(text, in: handle,
                               daysAgo: Double(161 - index) + offset, fromMe: true)
            }
        }
        let mirror = try MetricsFixture.mirror(
            of: try source.build(label: "voice-v2-global-diversity"),
            label: "voice-v2-global-diversity")
        let resolver = ContactResolver(salt: MetricsFixture.salt)
        let identities = try MetricLibrary(resolver: resolver,
                                           options: .init(now: MetricsFixture.now))
            .compute(mirror: mirror).relationships.map(\.identity)
        let global = try XCTUnwrap(try VoicePackBuilder(options: .init(now: MetricsFixture.now))
            .buildV2(mirror: mirror, identities: identities).first { $0.scope == "global" })

        XCTAssertEqual(global.exemplars.count, VoicePackBuilder.maximumExemplars)
        XCTAssertEqual(Set(global.exemplars.map(\.text)).count, global.exemplars.count)
        let alpha = global.exemplars.filter { $0.text.hasPrefix("alpha") }
        let beta = global.exemplars.filter { $0.text.hasPrefix("beta") }
        XCTAssertFalse(alpha.isEmpty)
        XCTAssertFalse(beta.isEmpty)
        XCTAssertLessThanOrEqual(abs(alpha.count - beta.count), 1)
        let indices = global.exemplars.compactMap { Int($0.text.split(separator: " ").last ?? "") }
        XCTAssertLessThanOrEqual(try XCTUnwrap(indices.min()), 10)
        XCTAssertGreaterThanOrEqual(try XCTUnwrap(indices.max()), 70)
    }
}
