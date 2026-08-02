import XCTest
@testable import BoiKit

/// NO MESSAGE CONTENT APPEARS IN THIS FILE OR IN ITS FAILURE OUTPUT.
///
/// The real blobs live in a gitignored fixture under `/tmp/boi-a`. Assertions compare
/// with `XCTAssertTrue(a == b)` rather than `XCTAssertEqual`, because `XCTAssertEqual`
/// prints both values on failure and that output ends up in logs and reports.
final class TypedStreamTests: XCTestCase {

    // MARK: - Malformed input

    /// A blob that cannot be read is a row with no recoverable text — a number the
    /// coverage report already tracks. It must never throw, and must never return a
    /// fragment of the surrounding binary as if it were a message.
    func testRandomBytesDecodeToNilRatherThanGarbage() {
        var generator = SystemRandomNumberGenerator()
        for length in [0, 1, 7, 64, 512, 4096] {
            let bytes = (0..<length).map { _ in UInt8.random(in: 0...255, using: &generator) }
            XCTAssertNil(TypedStream.decodeText(Data(bytes)),
                         "random \(length)-byte input produced a value")
        }
    }

    func testAnEmptyBlobDecodesToNil() {
        XCTAssertNil(TypedStream.decodeText(Data()))
    }

    /// The synthetic fixture's placeholder is deliberately not a typedstream. It must be
    /// reported as unrecoverable rather than crashing or being read as text.
    func testTheSyntheticPlaceholderIsNotMistakenForAMessage() {
        XCTAssertNil(TypedStream.decodeText(Data("__SYNTHETIC_NO_TYPEDSTREAM__".utf8)))
    }

    /// Truncation is the realistic corruption: a blob cut off mid-length-prefix must not
    /// read past its own end.
    func testATruncatedBlobDecodesToNil() {
        let full = Builder.blob(for: "a message that will be cut short")
        for cut in [4, 12, 20, full.count - 2] where cut > 0 && cut < full.count {
            XCTAssertNil(TypedStream.decodeText(full.prefix(cut)),
                         "a blob truncated at \(cut) bytes produced a value")
        }
    }

    func testABlobWithoutTheStreamtypedSignatureDecodesToNil() {
        var bytes = [UInt8](Builder.blob(for: "hello"))
        bytes[2] = 0x00   // corrupt the signature
        XCTAssertNil(TypedStream.decodeText(Data(bytes)))
    }

    // MARK: - Attachment placeholders

    /// `U+FFFC` is the object replacement character Messages leaves where an image or
    /// file bubble goes. It carries no text; letting it through puts a stray glyph into
    /// a gist, and from there into a draft sent under the user's own name.
    func testTheAttachmentPlaceholderIsStripped() throws {
        let decoded = try XCTUnwrap(
            TypedStream.decodeText(Builder.blob(for: "\u{FFFC}look at this")))
        XCTAssertTrue(decoded == "look at this")
        XCTAssertFalse(decoded.contains(TypedStream.attachmentPlaceholder))
    }

    func testAnAttachmentOnlyMessageDecodesToNilRatherThanEmptyText() {
        // Counting an image-only message as "recovered" would flatter the coverage
        // metric with rows that carry no text at all.
        XCTAssertNil(TypedStream.decodeText(Builder.blob(for: "\u{FFFC}")))
        XCTAssertNil(TypedStream.decodeText(Builder.blob(for: "\u{FFFC}\u{FFFC}   ")))
    }

    func testCleanKeepsOrdinaryTextIntact() {
        XCTAssertTrue(TypedStream.clean("ok sounds good") == "ok sounds good")
        XCTAssertTrue(TypedStream.clean("emoji 🥐 survive") == "emoji 🥐 survive")
        XCTAssertNil(TypedStream.clean("   "))
    }

    // MARK: - Structure

    func testAMultiByteLengthIsReadAsAWholeNumberNotASingleByte() throws {
        // A message longer than 127 characters uses the 0x81 two-byte length form.
        // Reading only the first byte truncates it, which looks like a short message
        // rather than like a bug.
        // No trailing space: `clean` trims, and a test that forgets that is testing
        // the trim rather than the length prefix.
        let long = String(repeating: "the quick brown fox ", count: 30) + "jumps"
        let decoded = try XCTUnwrap(TypedStream.decodeText(Builder.blob(for: long)))
        XCTAssertTrue(decoded == long)
        XCTAssertGreaterThan(decoded.count, 255)
    }

    func testDecodingIsPureAndRepeatable() throws {
        let blob = Builder.blob(for: "same in same out")
        let first = TypedStream.decodeText(blob)
        let second = TypedStream.decodeText(blob)
        XCTAssertTrue(first == second)
    }

    // MARK: - Real blobs

    /// Decodes real `attributedBody` blobs captured from the developer's own database.
    ///
    /// THIS TEST NEEDS A LOCAL FIXTURE THAT IS DELIBERATELY NOT COMMITTED. The blobs are
    /// real message content and never enter git. Regenerate it with:
    ///
    ///     swift run --package-path mac boi-cli capture-typedstream-fixture \
    ///       --db ~/Library/Messages/chat.db
    ///
    /// It fails, rather than skipping, when the fixture is absent: a skip here would
    /// hide the only test in the suite that exercises a real typedstream, and the
    /// suite would stay green while the decoder rotted. NOTES.md records that this
    /// makes the test unrunnable on a machine without the fixture.
    func testRealBlobsDecodeToTheStringAppleStoredInTheTextColumn() throws {
        guard let samples = TypedStreamFixture.load() else {
            return XCTFail("""
                no local typedstream fixture at \(TypedStreamFixture.defaultPath).
                It is gitignored on purpose -- it holds real message content. Rebuild it:
                  swift run --package-path mac boi-cli capture-typedstream-fixture \
                --db ~/Library/Messages/chat.db
                """)
        }

        XCTAssertGreaterThanOrEqual(samples.count, 3,
                                    "the criterion is at least three real blobs")

        for (index, sample) in samples.enumerated() {
            guard let blob = Data(base64Encoded: sample.blob_base64) else {
                XCTFail("sample \(index) is not valid base64")
                continue
            }
            let decoded = TypedStream.decodeText(blob)
            // Compared without printing either value: these are real messages.
            XCTAssertNotNil(decoded, "sample \(index) decoded to nil")
            XCTAssertTrue(decoded == TypedStream.clean(sample.expected),
                          "sample \(index) did not match the text column Apple wrote "
                          + "for the same row (lengths \(decoded?.count ?? -1) vs "
                          + "\(sample.expected.count))")
        }
    }

    /// Builds a typedstream in the shape Messages writes, for the cases that do not
    /// need a real blob. Deliberately NOT used for the correctness test above — a
    /// hand-made stream would only prove the decoder agrees with this builder.
    enum Builder {
        static func blob(for text: String) -> Data {
            var bytes = TypedStream.signature
            bytes += [0x81, 0xE8, 0x03]                      // system version 1000
            bytes += [0x84, 0x01, 0x40, 0x84, 0x84, 0x84]    // class chain preamble
            bytes += Array("NSString".utf8)
            bytes += [0x01, 0x94, 0x84, 0x01]

            bytes.append(0x2B)                               // string payload tag
            let utf8 = Array(text.utf8)
            if utf8.count < 0x80 {
                bytes.append(UInt8(utf8.count))
            } else if utf8.count <= 0xFFFF {
                bytes += [0x81, UInt8(utf8.count & 0xFF), UInt8(utf8.count >> 8)]
            } else {
                bytes.append(0x82)
                for shift in [0, 8, 16, 24] { bytes.append(UInt8((utf8.count >> shift) & 0xFF)) }
            }
            bytes += utf8
            bytes += [0x86]                                  // end marker
            return Data(bytes)
        }
    }
}

/// Coverage arithmetic, which is checkable without any real data.
final class TextCoverageTests: XCTestCase {

    private func message(_ source: ChatMessage.TextSource, hasBlob: Bool = true,
                         at date: Date? = nil) -> ChatMessage {
        ChatMessage(rowID: 1, guid: "g", text: source == .unrecoverable ? nil : "t",
                    textSource: source, hasAttributedBody: hasBlob, handleRowID: 1,
                    handle: nil, service: nil, date: date, isFromMe: false,
                    associatedMessageType: 0, chatRowID: 1, chatIdentifier: nil, chatStyle: 45)
    }

    func testSharesAndTheBar() {
        var coverage = TextCoverage()
        for _ in 0..<97 { coverage.record(message(.column, hasBlob: false)) }
        for _ in 0..<2 { coverage.record(message(.attributedBody)) }
        coverage.record(message(.unrecoverable))

        XCTAssertEqual(coverage.total, 100)
        XCTAssertEqual(coverage.unrecoverableShare, 0.01, accuracy: 0.0001)
        XCTAssertTrue(coverage.meetsBar)
        // Without the decoder, the two recovered rows would also have been lost.
        XCTAssertEqual(coverage.shareWithoutDecoder, 0.03, accuracy: 0.0001)
    }

    func testTheBarIsStrictlyUnderTwoPercent() {
        var coverage = TextCoverage()
        for _ in 0..<98 { coverage.record(message(.column, hasBlob: false)) }
        for _ in 0..<2 { coverage.record(message(.unrecoverable)) }
        XCTAssertEqual(coverage.unrecoverableShare, 0.02, accuracy: 0.0001)
        XCTAssertFalse(coverage.meetsBar, "exactly 2% must not pass a bar of 'under 2%'")
    }

    /// A row with no blob at all is empty at the source; a row whose blob failed to
    /// decode is a decoder bug. Conflating them hides the second behind the first.
    func testUnrecoverableRowsAreSplitByWhetherTheyEvenHadABlob() {
        var coverage = TextCoverage()
        coverage.record(message(.unrecoverable, hasBlob: true))
        coverage.record(message(.unrecoverable, hasBlob: false))
        XCTAssertEqual(coverage.unrecoverable, 2)
        XCTAssertEqual(coverage.unrecoverableWithBlob, 1)
    }

    /// Apple's "Keep Messages" setting caps history at 30 days, 1 year, or forever. A
    /// span of almost exactly a year is that cap, not a user who started texting a year
    /// ago, and prompt 06 has to tell those apart.
    func testAOneYearSpanIsFlaggedAsALikelyRetentionCap() {
        let end = Date(timeIntervalSince1970: 1_800_000_000)
        var capped = TextCoverage()
        capped.record(message(.column, at: end.addingTimeInterval(-365 * 86_400)))
        capped.record(message(.column, at: end))
        XCTAssertEqual(capped.spanDays, 365)
        XCTAssertTrue(capped.looksLikeOneYearRetentionCap)

        var deep = TextCoverage()
        deep.record(message(.column, at: end.addingTimeInterval(-900 * 86_400)))
        deep.record(message(.column, at: end))
        XCTAssertFalse(deep.looksLikeOneYearRetentionCap)
    }
}
