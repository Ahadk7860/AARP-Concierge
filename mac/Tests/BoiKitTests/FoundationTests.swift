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

    func testEveryDataSourceIsNamed() {
        XCTAssertEqual(Set(DataSource.allCases.map(\.rawValue)),
                       ["messages", "attachments", "contacts", "callHistory"])
    }
}
