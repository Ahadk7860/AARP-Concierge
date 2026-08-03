#!/usr/bin/env python3
"""Regenerate `mac/Sources/BoiKit/FactVocabulary.swift` from the Python source of truth.

AMENDMENT-001 moves `facts` extraction onto the Mac, which means a second implementation
of `intelligence/boi_intel/facts.py` in Swift. The two must agree token-for-token or the
fabrication gate diverges from the thing it gates.

Roughly 800 vocabulary words copied by hand is the obvious way for them to stop agreeing,
so they are generated here instead. `FactsTests.testVocabularyMatchesPython` re-reads the
Python sets at test time and fails if either side moves, which is what makes this
generator's output trustworthy rather than merely tidy — a generator nobody re-runs is a
stale file with a reassuring header.

    python3 scripts/generate_fact_vocabulary.py
"""

from __future__ import annotations

import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "intelligence"))

from boi_intel import facts as F  # noqa: E402
from boi_intel.redact import COMMON_GIVEN_NAMES, _NOT_A_SURNAME  # noqa: E402

OUT = REPO / "mac" / "Sources" / "BoiKit" / "FactVocabulary.swift"
BEGIN = "// BEGIN GENERATED VOCABULARY"
END = "// END GENERATED VOCABULARY"

HEADER = """public enum FactVocabulary {
"""


def swift_set(name: str, values, doc: str) -> str:
    # One trailing comma per line, not two. The join supplies no separator of its own.
    body = "\n".join(f'        "{v}",' for v in sorted(values))
    return f"    /// {doc}\n    static let {name}: Set<String> = [\n{body}\n    ]\n"


def swift_array(name: str, values, doc: str) -> str:
    body = ", ".join(f'"{v}"' for v in values)
    return f"    /// {doc}\n    static let {name}: [String] = [{body}]\n"


def main() -> int:
    parts = [HEADER]
    parts.append(swift_array("weekdays", list(F.WEEKDAYS),
                             "Lowercase; matched case-insensitively."))
    parts.append(swift_array("months", list(F.MONTHS),
                             "Full names and abbreviations, in the Python order."))
    parts.append(swift_array("relativeDays", list(F.RELATIVE_DAYS),
                             '"tomorrow", "this weekend" — falsifiable against a calendar.'))
    parts.append(swift_set("commonGivenNames", COMMON_GIVEN_NAMES,
                           "599 given names, for the LOWERCASE name rule. "
                           "The corpus is lowercase texting."))
    parts.append(swift_set("notASurname", _NOT_A_SURNAME,
                           "206 words that follow a given name without being a surname."))
    stopwords = ", ".join(f'"{w}"' for w in sorted(F._DATE_STOPWORDS))
    parts.append("    /// Words that pass the ordinal/weekday shapes but are not dates "
                 "in context.\n"
                 f"    static let dateStopwords: Set<String> = [{stopwords}]\n")
    parts.append(f"    static let maxPerCategory = {F.MAX_PER_CATEGORY}\n")
    parts.append(f"    static let maxFactWords = {F.MAX_FACT_WORDS}\n")
    parts.append(f"    static let maxFactChars = {F.MAX_FACT_CHARS}\n")
    parts.append("}\n")

    generated = "".join(parts)

    source = OUT.read_text()
    if BEGIN not in source or END not in source:
        print(f"markers missing in {OUT.relative_to(REPO)}", file=sys.stderr)
        return 1
    head, rest = source.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    OUT.write_text(f"{head}{BEGIN} — python3 scripts/generate_fact_vocabulary.py\n"
                   f"{generated}{END}{tail}")
    print(f"regenerated the vocabulary in {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
