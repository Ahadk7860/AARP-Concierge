#!/usr/bin/env python3
"""Guard three: no voice-pack exemplar traces to a message the user did not write.

CONTRACTS section 7 (corrected 2 Aug) is honest about what this can do: it is a
verbatim string check and a regression alarm, not a proof. It catches an `is_from_me`
filter deleted outright. It cannot see a redacted inbound message.

    python3 scripts/check_voice_pack_leak.py --mirror /tmp/boi-a/mirror.db --pack out/vp.json

WHY --mirror AND NOT --db, corrected 3 Aug. This script used to read `chat.db`
directly and build its sent-set from `text IS NOT NULL`. On a real Mac only about a
third of rows have a `text` column at all -- 9,940 of 30,998 on the corpus that found
this -- because the rest live in `attributedBody` as an Apple typedstream. So a phrase
the user genuinely sent was missing from the sent-set, and if anyone had ever said the
same words back, the checker called it a leak. 47 of 174 packs were flagged, every one
of them a false positive.

That is precisely the ~47%-of-the-corpus trap the typedstream decoder exists to solve,
reproduced inside the script written to guard the corpus. A guard that cries wolf on a
quarter of real users is worse than no guard: it trains people to ignore it.

The mirror already holds decoded text, so point this at the mirror. If you point it at
a raw `chat.db` it will measure the NULL-text share and REFUSE rather than report
numbers it cannot stand behind.

This is a frozen anchor. Do not weaken it to make a checklist green.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sqlite3
import sys

# Above this share of NULL-text rows, a raw chat.db cannot answer the question.
NULL_TEXT_REFUSAL_THRESHOLD = 0.05


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip().lower()


def _table_exists(con: sqlite3.Connection, name: str) -> bool:
    return con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def load_corpus(path: str, is_mirror: bool) -> tuple[set[str], set[str]]:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.text_factory = lambda b: b.decode("utf-8", errors="replace")

    if not _table_exists(con, "message"):
        sys.exit(f"{path}: no `message` table -- is this a chat.db or a Boi mirror?")

    if not is_mirror:
        total = con.execute("SELECT count(*) FROM message").fetchone()[0]
        null_text = con.execute(
            "SELECT count(*) FROM message WHERE text IS NULL"
        ).fetchone()[0]
        share = (null_text / total) if total else 0.0
        if share > NULL_TEXT_REFUSAL_THRESHOLD:
            con.close()
            sys.exit(
                f"REFUSING to check against a raw chat.db.\n\n"
                f"  {null_text:,} of {total:,} rows ({share:.1%}) have no `text` column; "
                f"their bodies are in `attributedBody` as a typedstream this script "
                f"cannot decode.\n"
                f"  Every one of those is a message the user may have sent that would be "
                f"missing from the sent-set, so genuine exemplars would be reported as "
                f"leaks.\n\n"
                f"  Point this at the Boi mirror instead, which holds decoded text:\n"
                f"    --mirror /tmp/boi-<letter>/mirror.db\n"
            )

    sent = {norm(r[0]) for r in con.execute(
        "SELECT text FROM message WHERE is_from_me = 1 AND text IS NOT NULL")}
    received = {norm(r[0]) for r in con.execute(
        "SELECT text FROM message WHERE is_from_me = 0 AND text IS NOT NULL")}
    con.close()
    return sent, received


def main() -> None:
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--mirror", help="Boi local mirror -- decoded text, the correct input")
    src.add_argument("--db", help="raw chat.db -- refused when its NULL-text share is high")
    ap.add_argument("--pack", required=True)
    a = ap.parse_args()

    pack = json.loads(pathlib.Path(a.pack).read_text())
    exemplars = [norm(e) for e in pack.get("exemplars", [])]
    if not exemplars:
        print("OK -- pack has no exemplars")
        return

    sent, received = load_corpus(a.mirror or a.db, is_mirror=bool(a.mirror))

    leaked = [e for e in exemplars if e in received and e not in sent]
    unknown = [e for e in exemplars if e not in sent and e not in received]

    if leaked:
        print(f"FAIL -- {len(leaked)} exemplar(s) originate from the OTHER PERSON.")
        for e in leaked[:10]:
            print(f"  LEAK: {e[:80]!r}")
        print("\nThis is the failure mode that makes every privacy claim false.")
        sys.exit(1)

    print(f"OK -- 0 exemplars traceable to inbound messages "
          f"({len(unknown)} redacted beyond verbatim match, {len(exemplars)} total)")


if __name__ == "__main__":
    main()
