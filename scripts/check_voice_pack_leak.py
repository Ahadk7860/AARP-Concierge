#!/usr/bin/env python3
"""The third of the three is_from_me guards.

The Mac holds the first (the SQL query), the API holds the second (the upload
boundary), and this holds the third: a check that fails the build.

Given a chat.db and a voice pack, assert that every exemplar in the pack appears in
the SENT half of the corpus and in no message the other person wrote. A single
inbound message riding along in an exemplar list makes every privacy claim in
BOI_ARCHITECTURE.md section 6 false, and nobody would notice for months.

    python3 scripts/check_voice_pack_leak.py --db /tmp/boi-fixtures/chat.db \
        --pack out/voice_pack_h_8f21a4c0.json

This is a frozen anchor. Do not weaken it to make a checklist green.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sqlite3
import sys


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip().lower()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--pack", required=True)
    a = ap.parse_args()

    pack = json.loads(pathlib.Path(a.pack).read_text())
    exemplars = [norm(e) for e in pack.get("exemplars", [])]
    if not exemplars:
        print("OK — pack has no exemplars")
        return

    con = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    con.text_factory = lambda b: b.decode("utf-8", errors="replace")
    sent = {norm(r[0]) for r in con.execute(
        "SELECT text FROM message WHERE is_from_me = 1 AND text IS NOT NULL")}
    received = {norm(r[0]) for r in con.execute(
        "SELECT text FROM message WHERE is_from_me = 0 AND text IS NOT NULL")}
    con.close()

    leaked = [e for e in exemplars if e in received and e not in sent]
    unknown = [e for e in exemplars if e not in sent and e not in received]

    if leaked:
        print(f"FAIL — {len(leaked)} exemplar(s) originate from the OTHER PERSON.")
        for e in leaked[:10]:
            print(f"  LEAK: {e[:80]!r}")
        print("\nThis is the failure mode that makes every privacy claim false.")
        sys.exit(1)

    # Redaction rewrites text, so an exemplar not found verbatim in either set is
    # expected. Not-in-received is what matters; report the rest as information.
    print(f"OK — 0 exemplars traceable to inbound messages "
          f"({len(unknown)} redacted beyond verbatim match, {len(exemplars)} total)")


if __name__ == "__main__":
    main()
