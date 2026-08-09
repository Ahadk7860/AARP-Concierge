import XCTest
@testable import BoiKit

/// Exercises the `ask_device` "search" path (§4.3) against a real `MirrorDatabase` file
/// — same schema, same `message_fts` index, same triggers `MirrorSync` uses — rather
/// than a synthetic fixture. `SearchIndex` opens its own read-only connection to the
/// same path, exactly as it will against the real `mirror.db`.
final class SearchIndexTests: XCTestCase {

    private func makeMirror() throws -> (path: String, mirror: MirrorDatabase) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("search-index-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("mirror.db").path
        let mirror = try MirrorDatabase(path: path)
        return (path, mirror)
    }

    private func message(
        rowID: Int64,
        guid: String,
        text: String?,
        handle: String,
        daysAgo: Int,
        chatIdentifier: String? = nil,
        associatedMessageType: Int = 0
    ) -> ChatMessage {
        ChatMessage(
            rowID: rowID,
            guid: guid,
            text: text,
            textSource: .column,
            hasAttributedBody: false,
            handleRowID: rowID,
            handle: handle,
            service: "iMessage",
            date: Date().addingTimeInterval(-Double(daysAgo) * 86_400),
            isFromMe: false,
            associatedMessageType: associatedMessageType,
            chatRowID: rowID,
            chatIdentifier: chatIdentifier ?? "chat_\(handle)",
            chatStyle: 0,
            wasDeliveredQuietly: false
        )
    }

    func testFindsRealHitAndReturnsWireShape() throws {
        let (path, mirror) = try makeMirror()
        try mirror.upsert(message(rowID: 1, guid: "g1", text: "let's talk about the trip to Tahoe",
                                   handle: "+15550001111", daysAgo: 3), seenAt: Date())
        try mirror.upsert(message(rowID: 2, guid: "g2", text: "totally unrelated dinner plans",
                                   handle: "+15550002222", daysAgo: 1), seenAt: Date())

        let index = try SearchIndex(path: path)
        let hits = try index.search(query: "trip", limit: 5)

        XCTAssertEqual(hits.count, 1)
        let hit = hits[0]
        XCTAssertEqual(hit.person_id, "+15550001111") // default personID = raw handle
        XCTAssertEqual(hit.thread_id, "chat_+15550001111")
        XCTAssertTrue(hit.snippet.contains("["), "snippet should highlight the match: \(hit.snippet)")
        XCTAssertGreaterThan(hit.score, 0)
        XCTAssertLessThanOrEqual(hit.score, 1)
    }

    func testWhoFilterNarrowsBeforeRanking() throws {
        let (path, mirror) = try makeMirror()
        // Same word, two different people — the `who` filter must return only Maya's,
        // not the top-N globally re-filtered afterwards (which would still be correct
        // here by luck; the point is the SQL does the narrowing).
        try mirror.upsert(message(rowID: 1, guid: "g1", text: "the trip is confirmed",
                                   handle: "maya@example.com", daysAgo: 2), seenAt: Date())
        try mirror.upsert(message(rowID: 2, guid: "g2", text: "the trip is cancelled",
                                   handle: "+15559998888", daysAgo: 1), seenAt: Date())

        let index = try SearchIndex(path: path)
        let handles = try index.distinctHandles()
        let resolver = WhoResolver()
        let filtered = resolver.resolve(who: "maya", distinctHandles: handles)
        XCTAssertEqual(filtered, ["maya@example.com"])

        let hits = try index.search(query: "trip", whoFilterHandles: filtered, limit: 5)
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(hits[0].person_id, "maya@example.com")
    }

    func testWhoFilterMatchingNobodyReturnsEmptyNotEverybody() throws {
        let (path, mirror) = try makeMirror()
        try mirror.upsert(message(rowID: 1, guid: "g1", text: "the trip is confirmed",
                                   handle: "+15550001111", daysAgo: 2), seenAt: Date())

        let index = try SearchIndex(path: path)
        let hits = try index.search(query: "trip", whoFilterHandles: [], limit: 5)
        XCTAssertEqual(hits, [])
    }

    func testDateRangeFilterIsAppliedInSQL() throws {
        let (path, mirror) = try makeMirror()
        try mirror.upsert(message(rowID: 1, guid: "g1", text: "old trip talk",
                                   handle: "+15550001111", daysAgo: 400), seenAt: Date())
        try mirror.upsert(message(rowID: 2, guid: "g2", text: "recent trip talk",
                                   handle: "+15550001111", daysAgo: 1), seenAt: Date())

        let index = try SearchIndex(path: path)
        let cutoff = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-30 * 86_400))
        let hits = try index.search(query: "trip", whenFrom: cutoff, limit: 5)

        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(hits[0].snippet.contains("recent") || hits[0].snippet.lowercased().contains("recent"), true)
    }

    func testTapbacksAreExcludedFromResults() throws {
        let (path, mirror) = try makeMirror()
        try mirror.upsert(message(rowID: 1, guid: "g1", text: "Loved \u{201c}see you at the trip\u{201d}",
                                   handle: "+15550001111", daysAgo: 1, associatedMessageType: 2000),
                          seenAt: Date())

        let index = try SearchIndex(path: path)
        let hits = try index.search(query: "trip", limit: 5)
        XCTAssertEqual(hits, [])
    }

    func testEmptyQueryReturnsNoResults() throws {
        let (path, mirror) = try makeMirror()
        try mirror.upsert(message(rowID: 1, guid: "g1", text: "anything",
                                   handle: "+15550001111", daysAgo: 1), seenAt: Date())
        let index = try SearchIndex(path: path)
        XCTAssertEqual(try index.search(query: "   ", limit: 5), [])
    }

    func testQuerySanitizesFTS5SpecialCharacters() throws {
        let (path, mirror) = try makeMirror()
        try mirror.upsert(message(rowID: 1, guid: "g1", text: "what's the plan",
                                   handle: "+15550001111", daysAgo: 1), seenAt: Date())
        let index = try SearchIndex(path: path)
        // A bare quote or leading `-`/`*` would otherwise be FTS5 query syntax, not a
        // literal token, and could throw a syntax error instead of matching.
        XCTAssertNoThrow(try index.search(query: "\"what's -- the* plan\"", limit: 5))
    }

    func testPersonIDInjectionIsUsedInsteadOfRawHandle() throws {
        let (path, mirror) = try makeMirror()
        try mirror.upsert(message(rowID: 1, guid: "g1", text: "trip planning",
                                   handle: "+15550001111", daysAgo: 1), seenAt: Date())
        let index = try SearchIndex(path: path, personID: { "p_" + $0 })
        let hits = try index.search(query: "trip", limit: 5)
        XCTAssertEqual(hits.first?.person_id, "p_+15550001111")
    }

    // MARK: - SearchRequestHandler / full wire round trip

    func testHandlerProducesOkWireResponse() throws {
        let (path, mirror) = try makeMirror()
        try mirror.upsert(message(rowID: 1, guid: "g1", text: "let's talk about the trip",
                                   handle: "+15550001111", daysAgo: 1), seenAt: Date())

        let index = try SearchIndex(path: path)
        let handler = SearchRequestHandler(index: index)
        let request = AskDeviceSearchRequest(id: "req_1", query: "trip", limit: 5)
        let response = handler.handle(request)

        guard case .ok(let v, let id, let results) = response else {
            return XCTFail("expected ok response, got \(response)")
        }
        XCTAssertEqual(v, 1)
        XCTAssertEqual(id, "req_1")
        XCTAssertEqual(results.count, 1)
    }

    func testHandlerReturnsNoGrantWhenGrantMissing() throws {
        let (path, _) = try makeMirror()
        let index = try SearchIndex(path: path)
        let handler = SearchRequestHandler(index: index, hasGrant: { false })
        let response = handler.handle(AskDeviceSearchRequest(id: "req_2", query: "trip", limit: 5))
        XCTAssertEqual(response, .failed(v: 1, id: "req_2", reason: .no_grant))
    }

    // MARK: - Codable wire shape

    func testResponseEncodingOmitsAbsentKeys() throws {
        let ok = AskDeviceSearchResponse.ok(v: 1, id: "req_3", results: [
            AskDeviceSearchResultRow(person_id: "p1", when: "2026-01-01T00:00:00Z",
                                     snippet: "[hi]", thread_id: "t1", score: 0.9),
        ])
        let okData = try JSONEncoder().encode(ok)
        let okObject = try JSONSerialization.jsonObject(with: okData) as? [String: Any]
        XCTAssertNil(okObject?["reason"])
        XCTAssertNotNil(okObject?["results"])

        let failed = AskDeviceSearchResponse.failed(v: 1, id: "req_4", reason: .asleep)
        let failedData = try JSONEncoder().encode(failed)
        let failedObject = try JSONSerialization.jsonObject(with: failedData) as? [String: Any]
        XCTAssertNil(failedObject?["results"])
        XCTAssertEqual(failedObject?["reason"] as? String, "asleep")
        XCTAssertEqual(failedObject?["ok"] as? Bool, false)
    }

    func testRequestDecodesFromExactSpecShape() throws {
        let json = """
            { "v": 1, "id": "req_5", "op": "search", "query": "trip",
              "who": "Maya", "when_from": "2026-01-01T00:00:00Z", "limit": 5 }
            """.data(using: .utf8)!
        let request = try JSONDecoder().decode(AskDeviceSearchRequest.self, from: json)
        XCTAssertEqual(request.v, 1)
        XCTAssertEqual(request.op, "search")
        XCTAssertEqual(request.who, "Maya")
        XCTAssertNil(request.when_to)
    }
}
