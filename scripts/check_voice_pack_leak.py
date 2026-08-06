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


def load_corpus(path: str, flag_says_mirror: bool) -> tuple[set[str], set[str]]:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.text_factory = lambda b: b.decode("utf-8", errors="replace")

    if not _table_exists(con, "message"):
        sys.exit(f"{path}: no `message` table -- is this a chat.db or a Boi mirror?")

    # DERIVE what the file IS; do not trust which flag was typed. Corrected 3 Aug.
    #
    # This used to be `is_mirror = bool(args.mirror)`, so the same chat.db gave two
    # answers: --db refused it, --mirror cleared it. Defeating the guard required no ill
    # intent at all -- just re-running the check and pointing the new flag at the path
    # already in your shell history. A guard whose safety depends on the operator already
    # knowing the thing it exists to tell them is not doing much.
    #
    # A Boi mirror carries a `mirror_meta` table. A chat.db does not. That is a
    # structural tell, so the flag becomes documentation of intent and the file becomes
    # the safety mechanism. Same principle as `from_handle` over `inbound.user_id`:
    # re-derive rather than trust what you were handed.
    is_mirror = _table_exists(con, "mirror_meta")

    if flag_says_mirror and not is_mirror:
        con.close()
        sys.exit(
            f"--mirror was given but {path} has no `mirror_meta` table, so it is not a "
            f"Boi mirror.\nRefusing rather than checking against a corpus whose text "
            f"column may be two thirds empty."
        )
    if not flag_says_mirror and is_mirror:
        print(f"note: {path} is a Boi mirror (mirror_meta present); "
              f"checking against decoded text.", file=sys.stderr)

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


# ---------------------------------------------------------------------------
# AMENDMENT-001: the fabrication-gate allowlist, wherever it lives
# ---------------------------------------------------------------------------
#
# `facts` now appears in TWO containers -- `gist.v1.facts` and
# `digest.v1.$defs/relationship.facts` -- under identical rules. This is the ONE function
# that enforces the no-verbatim rule on it, and both callers use it.
#
# A second implementation is the thing to avoid, not a second caller. The 3-word / 40-char
# cap is enforced by the JSON Schema, which is literally the same subschema in both files;
# the no-verbatim rule is enforced here. A cap enforced in one container and not the other
# is not a cap, and two checkers that drift are worse than one that is strict.

FACT_KEYS = ("dates", "times", "places", "amounts", "names")
MAX_FACT_WORDS = 3
MAX_FACT_CHARS = 40


def facts_violations(facts: dict, received: set[str]) -> list[str]:
    """Every way a `facts` object can be wrong, in either container.

    `received` is the normalised set of inbound messages. A token that IS an inbound
    message, or that is a long span of one, is the other person's prose wearing the shape
    of a fact -- the exact failure the 60-char cap once allowed when a place pattern
    captured four consecutive capitalised words.
    """
    problems: list[str] = []
    for key in FACT_KEYS:
        for token in facts.get(key) or []:
            if not isinstance(token, str) or not token.strip():
                problems.append(f"{key}: empty or non-string token")
                continue
            if len(token) > MAX_FACT_CHARS:
                problems.append(f"{key}: {len(token)} chars > {MAX_FACT_CHARS} -- {token[:20]!r}...")
            if len(token.split()) > MAX_FACT_WORDS:
                problems.append(
                    f"{key}: {len(token.split())} words > {MAX_FACT_WORDS} -- a fact is a "
                    f"token, not a clause"
                )
            n = norm(token)
            if n in received:
                problems.append(f"{key}: VERBATIM inbound message as a fact -- {token[:40]!r}")
            elif len(n) >= 12 and any(n in r for r in received):
                # A long token that is a SPAN of an inbound message. Short ones are
                # excluded because "friday" is legitimately inside somebody's sentence
                # and is exactly the kind of token the allowlist exists to carry.
                problems.append(f"{key}: verbatim SPAN of an inbound message -- {token[:40]!r}")
    return problems


def check_digest_facts(digest: dict, received: set[str]) -> list[str]:
    """The digest-side caller. Same function, different envelope."""
    out: list[str] = []
    for rel in digest.get("relationships", []):
        for problem in facts_violations(rel.get("facts") or {}, received):
            out.append(f"{rel.get('contact_id', '?')}: {problem}")
    return out


def check_gist_facts(gist: dict, received: set[str]) -> list[str]:
    """The gist-side caller. Same function, different envelope."""
    return [f"{gist.get('gist_id', '?')}: {p}"
            for p in facts_violations(gist.get("facts") or {}, received)]



def main() -> None:
    ap = argparse.ArgumentParser()
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--mirror", help="Boi local mirror -- decoded text, the correct input")
    src.add_argument("--db", help="raw chat.db -- refused when its NULL-text share is high")
    # Both flags are advisory. What the file IS decides, not which flag you typed.
    what = ap.add_mutually_exclusive_group(required=True)
    what.add_argument("--pack", help="a voice_pack.v1 document")
    what.add_argument("--digest", help="a digest.v1 document -- checks relationship.facts")
    what.add_argument("--gist", help="a gist.v1 document -- checks facts")
    a = ap.parse_args()

    # AMENDMENT-001. `facts` crosses the boundary in two containers now, and both are
    # checked by `facts_violations` above.
    if a.digest or a.gist:
        doc = json.loads(pathlib.Path(a.digest or a.gist).read_text())
        _, received = load_corpus(a.mirror or a.db, flag_says_mirror=bool(a.mirror))
        problems = (check_digest_facts(doc, received) if a.digest
                    else check_gist_facts(doc, received))

        # digest.v2 carries understanding fields that may contain derived prose.
        # Scan open_thread and voice_exemplars[].text against the received corpus.
        if a.digest and doc.get("schema_version") == "digest.v2":
            for rel in doc.get("relationships", []):
                understanding = rel.get("understanding", {})
                open_thread = understanding.get("open_thread")
                if isinstance(open_thread, str) and open_thread.strip():
                    n = norm(open_thread)
                    if n in received:
                        problems.append(
                            f"{rel.get('contact_id', '?')}: "
                            f"understanding.open_thread is verbatim inbound prose — {open_thread[:60]!r}"
                        )
                    elif len(n) >= 12 and any(n in r for r in received):
                        problems.append(
                            f"{rel.get('contact_id', '?')}: "
                            f"understanding.open_thread contains verbatim span — {open_thread[:60]!r}"
                        )
                cadence = understanding.get("cadence_norm")
                if isinstance(cadence, str) and cadence.strip():
                    n = norm(cadence)
                    if n in received:
                        problems.append(
                            f"{rel.get('contact_id', '?')}: "
                            f"understanding.cadence_norm is verbatim inbound prose — {cadence[:60]!r}"
                        )
                for vex in understanding.get("voice_exemplars", []):
                    if isinstance(vex, dict) and "text" in vex:
                        n = norm(vex["text"])
                        if n in received:
                            problems.append(
                                f"{rel.get('contact_id', '?')}: "
                                f"understanding.voice_exemplar text is verbatim inbound — {vex['text'][:60]!r}"
                            )

        if problems:
            print(f"FAIL -- {len(problems)} violation(s).")
            for p in problems[:10]:
                print(f"  {p}")
            print("\nThe allowlist is what the fabrication gate trusts. A token that is "
                  "somebody's\nsentence makes the gate license their prose in the user's "
                  "own name.")
            sys.exit(1)
        print("OK -- facts within the 3-word / 40-char cap, none verbatim from inbound")
        return

    pack = json.loads(pathlib.Path(a.pack).read_text())
    version = pack.get("schema_version", "voice_pack.v1")

    # voice_pack.v2 exemplars are objects { text, answered, register }, not strings.
    if version == "voice_pack.v2":
        raw_exemplars = pack.get("exemplars", [])
        exemplars = []
        for ex in raw_exemplars:
            if isinstance(ex, dict) and "text" in ex:
                exemplars.append(norm(ex["text"]))
    else:
        # voice_pack.v1: exemplars are plain strings
        exemplars = [norm(e) for e in pack.get("exemplars", []) if isinstance(e, str)]

    if not exemplars:
        print("OK -- pack has no exemplars")
        return

    sent, received = load_corpus(a.mirror or a.db, flag_says_mirror=bool(a.mirror))

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
