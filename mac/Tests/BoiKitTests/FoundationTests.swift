import XCTest
@testable import BoiKit

// Foundation harness. Track A extends this suite; it never weakens this file.

final class FoundationTests: XCTestCase {

    func testDigestRoundTripsThroughTheCommittedFixture() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // BoiKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // mac
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("contracts/fixtures/digest/healthy.json")

        let data = try Data(contentsOf: url)
        let digest = try JSONDecoder().decode(Digest.self, from: data)

        XCTAssertEqual(digest.schema_version, "digest.v1")
        XCTAssertEqual(digest.corpus.message_count, 83_887)
        XCTAssertEqual(digest.corpus.health, .fixable)
        XCTAssertEqual(digest.relationships.count, 5)

        let yu = try XCTUnwrap(digest.relationships.first { $0.display == "Yu" })
        XCTAssertEqual(yu.archetype, .fade)
        // Momentum discriminates (0.0x to 13.9x observed). Reciprocity does not.
        XCTAssertLessThan(yu.momentum_90d, 0.1)

        let reencoded = try JSONEncoder().encode(digest)
        XCTAssertFalse(reencoded.isEmpty)
    }

    func testVoicePackFixtureDecodes() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("contracts/fixtures/voice_pack/maya.json")
        let pack = try JSONDecoder().decode(VoicePack.self, from: Data(contentsOf: url))
        XCTAssertEqual(pack.scope, "contact")
        XCTAssertEqual(pack.n_exemplars, pack.exemplars.count)
        XCTAssertLessThanOrEqual(pack.exemplars.count, 40)
        XCTAssertEqual(pack.register.punctuation, .lowercaseNoPeriod)
    }

    func testDigestV2FixtureRoundTripsThroughItsSwiftMirror() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf:
            root.appendingPathComponent("contracts/fixtures/digest_v2/understood.json"))
        let digest = try JSONDecoder().decode(DigestV2.self, from: data)

        XCTAssertEqual(digest.schema_version, "digest.v2")
        XCTAssertEqual(digest.synced_through, "2026-08-01T09:10:00Z")
        let relationship = try XCTUnwrap(digest.relationships.first)
        XCTAssertEqual(relationship.understanding.relationship_kind, .closeFriend)
        XCTAssertEqual(relationship.understanding.last_exchange_shape, .questionFromThem)
        XCTAssertEqual(relationship.understanding.voice_exemplars.first?.answered,
                       .questionFromThem)

        let roundTrip = try JSONDecoder().decode(
            DigestV2.self, from: JSONEncoder().encode(digest))
        XCTAssertEqual(roundTrip.relationships.first?.understanding.topics, ["climbing"])
    }

    func testVoicePackV2FixtureHasOnlyContextualUserExemplars() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf:
            root.appendingPathComponent("contracts/fixtures/voice_pack_v2/maya.json"))
        let pack = try JSONDecoder().decode(VoicePackV2.self, from: data)

        XCTAssertEqual(pack.schema_version, "voice_pack.v2")
        XCTAssertEqual(pack.n_exemplars, pack.exemplars.count)
        XCTAssertEqual(pack.exemplars.first?.answered, .questionFromThem)
        XCTAssertEqual(pack.exemplars.first?.register, .warm)
        XCTAssertFalse(try JSONEncoder().encode(pack).isEmpty)
    }

    func testEveryDataSourceIsNamed() {
        XCTAssertEqual(Set(DataSource.allCases.map(\.rawValue)),
                       ["messages", "attachments", "contacts", "callHistory"])
    }
}
