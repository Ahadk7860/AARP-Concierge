import XCTest
@testable import BoiKit

final class DigestBuilderV2Tests: XCTestCase {
    private static let canary = "ZZQ-DIGEST-V2-INBOUND-PROSE-MUST-STAY-LOCAL"

    private func buildDigest(lastFromMe: Bool = false) throws -> (DigestV2, MirrorDatabase) {
        var source = MetricsFixture.ChatBuilder()
        source.message(Self.canary + " are you coming climbing?", in: "+15550100001",
                       daysAgo: 8)
        source.message("yeah ill be there", in: "+15550100001", daysAgo: 7, fromMe: true)
        source.message("Loved \"" + Self.canary + "\"", in: "+15550100001",
                       daysAgo: 6, fromMe: true, tapbackType: 2000)
        source.message(lastFromMe ? "ok talk soon" : "one more question?",
                       in: "+15550100001", daysAgo: 1, fromMe: lastFromMe)
        let mirror = try MetricsFixture.mirror(
            of: try source.build(label: "digest-v2"), label: "digest-v2")
        let resolver = ContactResolver(salt: MetricsFixture.salt)
        let result = try MetricLibrary(
            resolver: resolver,
            options: .init(now: MetricsFixture.now, timeZone: TimeZone(identifier: "UTC")!)
        ).compute(mirror: mirror)
        let signals = try FactExtractor.signalsByContact(
            mirror: mirror, identities: result.relationships.map(\.identity))
        let digest = try DigestBuilder(
            resolver: resolver,
            options: .init(userID: "usr_demo0001", deviceID: "dev_demo0001",
                           generatedAt: MetricsFixture.now, signalsByContact: signals)
        ).buildV2(from: result, mirror: mirror)
        return (digest, mirror)
    }

    func testDigestV2CarriesHorizonAndBoundedUnderstanding() throws {
        let (digest, mirror) = try buildDigest()
        let relationship = try XCTUnwrap(digest.relationships.first)
        let newest = try MetricsFixture.newestMessage(in: mirror)

        XCTAssertEqual(digest.schema_version, "digest.v2")
        XCTAssertEqual(digest.synced_through, StructuredLog.timestamp(newest))
        XCTAssertEqual(relationship.understanding.last_exchange_shape, .questionFromThem)
        XCTAssertEqual(relationship.understanding.open_thread,
                       "unanswered question from them")
        XCTAssertTrue(relationship.understanding.topics.allSatisfy {
            $0.count <= UnderstandingBuilder.maximumTopicCharacters
                && $0.split(separator: " ").count <= UnderstandingBuilder.maximumTopicWords
        })
        XCTAssertLessThanOrEqual(relationship.understanding.voice_exemplars.count, 40)
    }

    func testNoCounterpartOrSentTapbackProseSerializes() throws {
        let (digest, _) = try buildDigest()
        let encoded = try JSONEncoder().encode(digest)
        let text = try XCTUnwrap(String(data: encoded, encoding: .utf8))

        XCTAssertFalse(text.contains(Self.canary))
        XCTAssertFalse(text.contains("Loved"))
        XCTAssertTrue(digest.relationships.flatMap(\.understanding.voice_exemplars)
            .allSatisfy { !$0.text.isEmpty && $0.text.count <= 200 })
    }

    func testWriterEmitsNullableUnderstandingFieldsAndValidatesSchema() throws {
        var (digest, _) = try buildDigest(lastFromMe: true)
        digest.relationships[0].understanding.cadence_norm = nil
        let path = "/tmp/boi-a/tests/digest-v2-wire-\(UUID().uuidString).json"
        try DigestBuilder.write(digest, to: path)

        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data)
            as? [String: Any])
        let rows = try XCTUnwrap(object["relationships"] as? [[String: Any]])
        let understanding = try XCTUnwrap(rows.first?["understanding"] as? [String: Any])
        XCTAssertTrue(understanding["open_thread"] is NSNull)
        XCTAssertTrue(understanding["cadence_norm"] is NSNull)

        let script = Fixture.repositoryRoot
            .appendingPathComponent("scripts/validate_fixtures.py").path
        let output = try Fixture.run("/usr/bin/python3", [script, "digest.v2", path])
        XCTAssertTrue(output.contains("OK"), output)
    }

    func testDigestV2IsByteDeterministicForTheSameInputs() throws {
        let (digest, mirror) = try buildDigest()
        let resolver = ContactResolver(salt: MetricsFixture.salt)
        let result = try MetricLibrary(
            resolver: resolver,
            options: .init(now: MetricsFixture.now, timeZone: TimeZone(identifier: "UTC")!)
        ).compute(mirror: mirror)
        let signals = try FactExtractor.signalsByContact(
            mirror: mirror, identities: result.relationships.map(\.identity))
        let second = try DigestBuilder(
            resolver: resolver,
            options: .init(userID: "usr_demo0001", deviceID: "dev_demo0001",
                           generatedAt: MetricsFixture.now, signalsByContact: signals)
        ).buildV2(from: result, mirror: mirror)

        let firstPath = "/tmp/boi-a/tests/digest-v2-first-\(UUID().uuidString).json"
        let secondPath = "/tmp/boi-a/tests/digest-v2-second-\(UUID().uuidString).json"
        try DigestBuilder.write(digest, to: firstPath)
        try DigestBuilder.write(second, to: secondPath)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: firstPath)),
                       try Data(contentsOf: URL(fileURLWithPath: secondPath)))
    }
}
