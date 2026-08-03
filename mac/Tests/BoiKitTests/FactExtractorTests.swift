import XCTest
@testable import BoiKit

/// The Swift half of AMENDMENT-001's riskiest requirement.
///
/// `FactExtractor` is a port of `intelligence/boi_intel/facts.py`, and the amendment is
/// explicit that two implementations which must agree token-for-token are exactly how a
/// fabrication gate drifts from the thing it gates. So the load-bearing test in this file
/// is not "does the extractor find dates" — it is **"does it find the same dates Python
/// finds, on the same input"**, run against the real Python module in a subprocess.
///
/// A test that asserted only against hand-written expectations would pass forever while
/// the two implementations diverged, which is the failure this whole file exists to
/// prevent.
final class FactExtractorTests: XCTestCase {

    // MARK: - Agreement with Python

    /// Inputs chosen to hit every pattern family and every rule that is easy to get
    /// wrong in translation, not to be realistic.
    static let corpus: [String] = [
        "hey are you still coming on the 14th? we need to book by friday",
        "dinner at 7pm on 8/14 works, or 8/15 if that is better",
        "i can do noon or 12:30pm tomorrow",
        "it was $120 total, or 40 bucks each",
        "we ended up at Jenny And Marks Wedding Reception",
        "meet me at the Ferry Building",
        "ask john smith about it, he was at the office",
        "see you at 3",
        "this weekend or next weekend both work",
        "aug 3 and 3 aug are the same day",
        "may is a month and also a stopword",
        "at your place then",
        "Sarah Connor said next thursday",
        "no specifics in this one at all",
    ]

    /// **THE AGREEMENT ASSERTION.** Shells out to the real `boi_intel.facts` and demands
    /// the two extractors produce identical allowlists — same tokens, same order, same
    /// categories.
    func testAgreesWithPythonTokenForToken() throws {
        let swift = FactExtractor.extract(from: Self.corpus)
        let python = try Self.pythonExtract(Self.corpus)

        // Compared category by category so a failure names which pattern family drifted
        // rather than dumping two whole objects.
        XCTAssertEqual(swift.dates, python.dates, "dates disagree")
        XCTAssertEqual(swift.times, python.times, "times disagree")
        XCTAssertEqual(swift.places, python.places, "places disagree")
        XCTAssertEqual(swift.amounts, python.amounts, "amounts disagree")
        XCTAssertEqual(swift.names, python.names, "names disagree")

        // And the corpus must actually exercise the thing: an agreement between two
        // empty results is not an agreement.
        XCTAssertFalse(swift.allTokens.isEmpty, "the corpus produced no facts at all")
        XCTAssertFalse(swift.dates.isEmpty)
        XCTAssertFalse(swift.times.isEmpty)
        XCTAssertFalse(swift.amounts.isEmpty)
    }

    /// Per-message agreement, so a failure points at one sentence rather than the whole
    /// corpus. Slower, and worth it the first time somebody changes a pattern.
    func testAgreesWithPythonOnEveryMessageIndividually() throws {
        for (index, message) in Self.corpus.enumerated() {
            let swift = FactExtractor.extract(from: [message])
            let python = try Self.pythonExtract([message])
            XCTAssertEqual(swift, python, "message \(index) disagrees: \(message)")
        }
    }

    func testVocabularyMatchesPython() throws {
        let python = try Self.pythonVocabulary()
        XCTAssertEqual(FactVocabulary.weekdays, python["weekdays"])
        XCTAssertEqual(FactVocabulary.months, python["months"])
        XCTAssertEqual(FactVocabulary.relativeDays, python["relative_days"])
        XCTAssertEqual(Set(FactVocabulary.commonGivenNames), Set(python["given_names"] ?? []))
        XCTAssertEqual(Set(FactVocabulary.notASurname), Set(python["not_a_surname"] ?? []))
        // The generated file is only trustworthy if somebody re-runs the generator. This
        // is what makes that true without anybody remembering to.
        XCTAssertEqual(FactVocabulary.commonGivenNames.count, 599)
        XCTAssertEqual(FactVocabulary.notASurname.count, 206)
    }

    // MARK: - The rules that are load-bearing

    func testCaseSensitivityIsSignalForNamesAndPlaces() {
        // Under `.caseInsensitive` the capitalised-name pattern degrades into "any two
        // to four words" and starts harvesting whole sentences. This asserts the
        // degraded behaviour does NOT happen.
        let facts = FactExtractor.extract(from: ["we should probably go there soon i think"])
        XCTAssertEqual(facts.names, [], "a lowercase sentence is not a name")
        XCTAssertEqual(facts.places, [], "and it is not a place either")
    }

    func testAFiveWordCapitalisedRunIsDroppedWholeRatherThanSliced() {
        // The prior art the amendment points at: at the old cap a place pattern
        // harvested "Jenny And Marks Wedding" out of a longer run — the other person's
        // prose, verbatim, inside the object built to keep it out. Bounding the pattern
        // rather than dropping the match would slice it into plausible 3-word spans.
        let facts = FactExtractor.extract(from: ["we ended up at Jenny And Marks Wedding Reception"])
        for token in facts.allTokens {
            XCTAssertLessThanOrEqual(token.split(separator: " ").count, 3, "\(token) is a clause")
            XCTAssertFalse(token.contains("Jenny And Marks"), "a prose span survived: \(token)")
        }
    }

    func testNoTokenSpansTwoMessages() {
        // `[^\S\n]` is whitespace-that-is-not-a-newline, and each message is scanned
        // separately. Both guards exist so a pattern cannot splice two people's
        // sentences into one "fact".
        let facts = FactExtractor.extract(from: ["see you at", "Union Square tomorrow"])
        for token in facts.allTokens {
            XCTAssertFalse(token.contains("\n"))
        }
    }

    func testEveryTokenIsInsideTheContractCap() {
        // CONTRACTS.md § 1 and the `gist.v1.facts` / `digest.v1` subschema: 3 words, 40
        // characters. The schema enforces it at the boundary; this enforces it at the
        // source, so a violation is caught before it is serialized.
        let facts = FactExtractor.extract(from: Self.corpus)
        for token in facts.allTokens {
            XCTAssertLessThanOrEqual(token.count, 40, token)
            XCTAssertLessThanOrEqual(token.split(separator: " ").count, 3, token)
            XCTAssertFalse(token.isEmpty)
        }
    }

    func testLowercaseNamesAreFoundBecauseTheCorpusIsLowercaseTexting() throws {
        // The same blind spot the voice pack had: a capitalised-only rule finds nothing
        // in real texting, which is why `_lowercase_names` exists.
        let found = FactExtractor.extract(from: ["john smith said no"])
        XCTAssertTrue(found.names.contains("john smith"), "\(found.names)")
        XCTAssertEqual(found, try Self.pythonExtract(["john smith said no"]))
    }

    /// A REAL GAP IN `facts.py`, reproduced faithfully rather than fixed.
    ///
    /// `_lowercase_names` scans with non-overlapping `finditer` over
    /// `([a-z…]+)\s+([a-z…]+)`, so on `"ask john smith about it"` the first match
    /// consumes `"ask john"` and `"john smith"` is never considered. A lowercase name is
    /// found only when the word in front of it is not itself lowercase-word-shaped —
    /// which, in real texting, is most of the time it is *not* found.
    ///
    /// The consequence is on the fabrication gate: a name the extractor misses is a name
    /// absent from the allowlist, so a draft naming it is rejected. That fails CLOSED,
    /// which is the safe direction — but it means `names` covers less than it looks like
    /// it covers, and `CONTRACTS.md` § 1's "known and bounded" list should say so.
    ///
    /// Not fixed here: prompt `03` moves the producer's input, it does not tune the
    /// producer. Recorded in NOTES.md.
    func testALowercaseNameMidSentenceIsMissed_knownGapNotFixedHere() throws {
        let messages = ["ask john smith about it"]
        let swift = FactExtractor.extract(from: messages)
        XCTAssertEqual(swift.names, [], "the gap is real")
        // And the port agrees with Python about the gap, which is the property that
        // matters: a port that silently "improved" on this would diverge from the gate.
        XCTAssertEqual(swift, try Self.pythonExtract(messages))
    }

    func testTheEmptyAllowlistIsAValidAnswer() {
        let facts = FactExtractor.extract(from: ["ok", "lol", "sounds good"])
        XCTAssertEqual(facts.allTokens, [])
        // Still structurally complete — five keys, five empty lists.
        XCTAssertEqual(facts, Facts.empty)
    }

    // MARK: - Python bridge

    static func pythonExtract(_ messages: [String]) throws -> Facts {
        let script = """
            import json, sys
            sys.path.insert(0, sys.argv[1])
            from boi_intel.facts import extract_facts
            print(json.dumps(extract_facts(json.loads(sys.argv[2]))))
            """
        let out = try run(script, arguments: [
            Fixture.repositoryRoot.appendingPathComponent("intelligence").path,
            String(data: try JSONEncoder().encode(messages), encoding: .utf8) ?? "[]",
        ])
        guard let data = out.data(using: .utf8) else {
            throw Fixture.FixtureUnavailable(detail: "python produced nothing: \(out)")
        }
        return try JSONDecoder().decode(Facts.self, from: data)
    }

    static func pythonVocabulary() throws -> [String: [String]] {
        let script = """
            import json, sys
            sys.path.insert(0, sys.argv[1])
            from boi_intel import facts as F
            from boi_intel.redact import COMMON_GIVEN_NAMES, _NOT_A_SURNAME
            print(json.dumps({
                "weekdays": list(F.WEEKDAYS),
                "months": list(F.MONTHS),
                "relative_days": list(F.RELATIVE_DAYS),
                "given_names": sorted(COMMON_GIVEN_NAMES),
                "not_a_surname": sorted(_NOT_A_SURNAME),
            }))
            """
        let out = try run(script, arguments: [
            Fixture.repositoryRoot.appendingPathComponent("intelligence").path,
        ])
        guard let data = out.data(using: .utf8) else {
            throw Fixture.FixtureUnavailable(detail: "python produced nothing")
        }
        return try JSONDecoder().decode([String: [String]].self, from: data)
    }

    /// The project venv, because `pyproject.toml` requires >= 3.11 and macOS ships 3.9.
    static func run(_ script: String, arguments: [String]) throws -> String {
        let venv = Fixture.repositoryRoot.appendingPathComponent(".venv/bin/python").path
        let executable = FileManager.default.isExecutableFile(atPath: venv) ? venv : "/usr/bin/python3"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["-c", script] + arguments
        let pipe = Pipe(), errors = Pipe()
        process.standardOutput = pipe
        process.standardError = errors
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let errorData = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw Fixture.FixtureUnavailable(
                detail: "python exited \(process.terminationStatus): "
                    + (String(data: errorData, encoding: .utf8) ?? ""))
        }
        return String(data: data, encoding: .utf8) ?? ""
    }
}
