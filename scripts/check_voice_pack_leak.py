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


# ---------------------------------------------------------------------------
# AMENDMENT-002: the `understanding.open_thread` closed grammar
# ---------------------------------------------------------------------------
#
# SOURCE OF TRUTH: mac/Sources/BoiKit/UnderstandingBuilder.swift -- the four literal
# descriptions returned by `outstandingThread`, and the `topicMarkers` token column.
# The constants below are a COPY of that vocabulary, and the copy is deliberate:
# this script has to know the closed set to be able to reject anything outside it.
#
# DRIFT BETWEEN THE TWO IS ITSELF A BUG, AND THIS CHECK IS HOW IT SURFACES. If somebody
# adds a seventh topic token to the Swift and not to this file, every digest carrying it
# FAILS here. That is the designed behaviour, not an accident to be papered over: the
# alternative is a checker that silently accepts whatever the builder feels like emitting,
# which is the same as having no checker. A legitimate new token costs one line here and
# a moment's thought about whether it is really a closed-vocabulary token; an illegitimate
# one costs a privacy incident. Fail loudly, never pass silently.
#
# WHY A WHITELIST AND NOT A BLACKLIST. `open_thread` used to be one of four frozen
# strings, so the verbatim / >=12-char-span checks further down were adequate: nothing
# variable could enter the field at all. Once a token is interpolated, those checks stop
# being sufficient. `apartment` is nine characters, below the 12-character span floor that
# exists so ordinary short words like "friday" are not flagged. A builder that was buggy
# -- or hostile -- could therefore smuggle a short inbound fragment through the field and
# both existing checks would shrug. The only thing that closes that hole is refusing to
# reason about what a bad token looks like and instead enumerating every good one.
# An unrecognised token IS the finding.

OPEN_THREAD_TOPIC_VOCABULARY = frozenset({
    "apartment", "climbing", "family", "plans", "school", "work",
})

# Independent of membership above. `topicMarkers` tokens are short by construction, so
# these caps should never bind -- which is exactly why they are worth asserting. If one
# ever does bind, the thing in the slot is not a token, it is somebody's clause.
MAX_OPEN_THREAD_TOPIC_WORDS = 3
MAX_OPEN_THREAD_TOPIC_CHARS = 40

# The four descriptions, each with `{about}` marking the ONE position the optional
# `about the <token>` clause may occupy. The marker is in the template string rather than
# in a comment so the documented position and the enforced position cannot disagree.
#
#   "asked more than once, unanswered"
#     -> "asked more than once about the apartment, unanswered"
#
# The slot for the two templates without a published example is fixed here by the same
# rule -- immediately after the noun the clause modifies -- and must be reconciled against
# the Swift when the interpolation lands.
OPEN_THREAD_TEMPLATES = (
    "asked more than once{about}, unanswered",
    "unanswered question from them{about}",
    "raised the plan more than once{about}, unresolved",
    "plan{about} appears unresolved",
)

OPEN_THREAD_CLAUSE_PREFIX = " about the "

# One anchored pattern per template. The slot capture is deliberately PERMISSIVE (`.+?`):
# we want whatever a builder actually put there to be captured and then judged against the
# vocabulary, rather than silently failing to match and losing the ability to say what was
# wrong. Matching is case-sensitive against the whitespace-collapsed string; the templates
# are literals in Swift, so there is no legitimate casing or spacing variance to tolerate.
_OPEN_THREAD_PATTERNS = tuple(
    re.compile(
        "^"
        + re.escape(head)
        + "(?:" + re.escape(OPEN_THREAD_CLAUSE_PREFIX) + "(?P<topic>.+?))?"
        + re.escape(tail)
        + "$"
    )
    for head, tail in (t.split("{about}") for t in OPEN_THREAD_TEMPLATES)
)


def open_thread_violations(open_thread: object) -> list[str]:
    """Every way a non-null `open_thread` can fall outside the closed grammar.

    Returns [] for `None`: no outstanding turn is a legitimate reading, and absence is
    never reported as a finding. Anything else must be a string that matches one of the
    four templates, optionally carrying an `about the <token>` clause whose token is a
    member of the closed topic vocabulary and within the per-token cap.

    This does not replace the verbatim / span checks against the inbound corpus -- it sits
    alongside them. Those catch a long quote; this catches a short one, and also catches
    the case where the corpus this script happens to be pointed at does not contain the
    leaked text at all.
    """
    if open_thread is None:
        return []
    if not isinstance(open_thread, str):
        return [f"understanding.open_thread is {type(open_thread).__name__}, "
                f"not a string or null"]

    candidate = re.sub(r"\s+", " ", open_thread).strip()
    if not candidate:
        return ["understanding.open_thread is present but empty -- emit null for "
                "'no outstanding turn', never a blank string"]

    for pattern in _OPEN_THREAD_PATTERNS:
        match = pattern.match(candidate)
        if match is None:
            continue
        topic = match.group("topic")
        if topic is None:
            return []  # a bare template, the pre-interpolation shape. Fine.

        problems: list[str] = []
        # Cap first, and independently of membership: a token over the cap is a clause
        # regardless of whether somebody also added it to the vocabulary above.
        if len(topic) > MAX_OPEN_THREAD_TOPIC_CHARS:
            problems.append(
                f"understanding.open_thread topic is {len(topic)} chars > "
                f"{MAX_OPEN_THREAD_TOPIC_CHARS} -- {topic[:40]!r}"
            )
        if len(topic.split()) > MAX_OPEN_THREAD_TOPIC_WORDS:
            problems.append(
                f"understanding.open_thread topic is {len(topic.split())} words > "
                f"{MAX_OPEN_THREAD_TOPIC_WORDS} -- a topic is a token, not a clause "
                f"-- {topic[:40]!r}"
            )
        if topic not in OPEN_THREAD_TOPIC_VOCABULARY:
            problems.append(
                f"understanding.open_thread topic {topic[:40]!r} is not in the closed "
                f"topic vocabulary -- either the counterpart's words reached the field, "
                f"or UnderstandingBuilder.topicMarkers gained a token this script was "
                f"not told about. Both are bugs; neither is allowed to pass quietly."
            )
        return problems

    return [
        f"understanding.open_thread does not match the closed grammar -- "
        f"{open_thread[:60]!r}. Only the four UnderstandingBuilder descriptions are "
        f"permitted, with at most an `about the <token>` clause at the documented slot."
    ]


# ---------------------------------------------------------------------------
# AMENDMENT-003: a finding nobody can read is not a finding
# ---------------------------------------------------------------------------
#
# Found on 7 Aug by running this guard against the real corpus rather than a fixture.
# A real inbound sentence was planted into `understanding.open_thread`, `--digest` was
# run, and the output was INDISTINGUISHABLE from a clean run. The check was working
# perfectly. Two things downstream of it hid the result, and neither is a bug in the
# check itself:
#
#   1. The exit code was ALREADY 1. `relationship.facts` carries 825 standing violations
#      on this corpus -- short allowlist tokens like 'today' that are also, verbatim,
#      somebody's entire message. So "did it exit non-zero" answers a question nobody
#      was asking, and cannot answer the one they were.
#   2. The report printed `problems[:10]`, and all ten were facts. The open_thread
#      finding was number 826.
#
# The operator saw the same ten lines either way. The only tell that a privacy leak had
# entered the boundary was a total ticking 825 -> 826, in a number nobody memorises.
#
# Raising the cap is not the fix; 826 lines is not a report either. Findings are now
# CATEGORISED BY FIELD, every field present is named with its own count, and every field
# gets its own examples. A noisy field can no longer bury a quiet one -- which is the
# property that actually matters here, because the rare finding is the dangerous one.
# The common one is a known tuning problem in the fact extractor; the rare one is
# somebody's prose crossing the boundary.
#
# This is a frozen anchor for the same reason the rest of the file is. If a future change
# makes violations print as a flat list again, this failure comes straight back.

FIELD_FACTS = "relationship.facts"
FIELD_GIST_FACTS = "gist.facts"
FIELD_OPEN_THREAD = "understanding.open_thread"
FIELD_CADENCE = "understanding.cadence_norm"
FIELD_EXEMPLAR = "understanding.voice_exemplars[].text"

# Per FIELD, not per run. Five is enough to see a pattern; the count tells you the size.
EXAMPLES_PER_FIELD = 5


class Findings:
    """Violations grouped by the field they were found in, so none can be crowded out."""

    def __init__(self) -> None:
        self._by_field: dict[str, list[str]] = {}

    def add(self, field: str, message: str) -> None:
        self._by_field.setdefault(field, []).append(message)

    def extend(self, field: str, messages: list[str]) -> None:
        for message in messages:
            self.add(field, message)

    def __len__(self) -> int:
        return sum(len(v) for v in self._by_field.values())

    def report(self) -> None:
        print(f"FAIL -- {len(self)} violation(s) across {len(self._by_field)} field(s).")
        # Sorted so the same corpus always reports in the same order and two runs can be
        # diffed against each other.
        for field in sorted(self._by_field):
            messages = self._by_field[field]
            print(f"\n  {field} -- {len(messages)} violation(s)")
            for message in messages[:EXAMPLES_PER_FIELD]:
                print(f"    {message}")
            remaining = len(messages) - EXAMPLES_PER_FIELD
            if remaining > 0:
                print(f"    ... and {remaining} more in this field")
        print("\nThe allowlist is what the fabrication gate trusts. A token that is "
              "somebody's\nsentence makes the gate license their prose in the user's "
              "own name.")


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
        findings = Findings()
        if a.digest:
            findings.extend(FIELD_FACTS, check_digest_facts(doc, received))
        else:
            findings.extend(FIELD_GIST_FACTS, check_gist_facts(doc, received))

        # digest.v2 carries understanding fields that may contain derived prose.
        # Scan open_thread and voice_exemplars[].text against the received corpus.
        if a.digest and doc.get("schema_version") == "digest.v2":
            for rel in doc.get("relationships", []):
                understanding = rel.get("understanding", {})
                open_thread = understanding.get("open_thread")

                # AMENDMENT-002. Structural first, and unconditionally: the corpus checks
                # below can only see text they can find in the mirror, and a nine-letter
                # token is under the 12-char span floor anyway. The grammar does not need
                # the corpus to say no.
                for problem in open_thread_violations(open_thread):
                    findings.add(FIELD_OPEN_THREAD,
                                 f"{rel.get('contact_id', '?')}: {problem}")

                if isinstance(open_thread, str) and open_thread.strip():
                    n = norm(open_thread)
                    if n in received:
                        findings.add(FIELD_OPEN_THREAD,
                            f"{rel.get('contact_id', '?')}: "
                            f"understanding.open_thread is verbatim inbound prose — {open_thread[:60]!r}"
                        )
                    elif len(n) >= 12 and any(n in r for r in received):
                        findings.add(FIELD_OPEN_THREAD,
                            f"{rel.get('contact_id', '?')}: "
                            f"understanding.open_thread contains verbatim span — {open_thread[:60]!r}"
                        )
                cadence = understanding.get("cadence_norm")
                if isinstance(cadence, str) and cadence.strip():
                    n = norm(cadence)
                    if n in received:
                        findings.add(FIELD_CADENCE,
                            f"{rel.get('contact_id', '?')}: "
                            f"understanding.cadence_norm is verbatim inbound prose — {cadence[:60]!r}"
                        )
                for vex in understanding.get("voice_exemplars", []):
                    if isinstance(vex, dict) and "text" in vex:
                        n = norm(vex["text"])
                        if n in received:
                            findings.add(FIELD_EXEMPLAR,
                                f"{rel.get('contact_id', '?')}: "
                                f"understanding.voice_exemplar text is verbatim inbound — {vex['text'][:60]!r}"
                            )

        if len(findings):
            findings.report()
            sys.exit(1)
        print("OK -- facts within the 3-word / 40-char cap, none verbatim from inbound")
        if a.digest and doc.get("schema_version") == "digest.v2":
            print("OK -- every open_thread matches the closed grammar; any topic token "
                  "is in the closed vocabulary and within the cap")
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
