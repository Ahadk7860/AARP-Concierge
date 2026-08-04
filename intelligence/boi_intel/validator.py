"""The validator, which is not a model.

    python -m boi_intel.validator --bundle b.json --gist g.json --voice-pack vp.json

Rules, deterministic, no model. It is not a model because its job is to be **boringly
reliable at refusing**, and a model asked to judge its own family's output grades
gently. Every gate here is arithmetic or a table lookup, so it returns the same verdict
on Tuesday as it did on Monday and a reviewer can work out why by reading it.

Six gates, and the vocabulary is frozen (`contracts.VALIDATOR_FAILURES`):

- `empty` — nothing usable came back.
- `length_gate` — longer than `max(median * avg_msgs_per_burst, p90) + 30`.
- `register_gate` — capitalised when they never capitalise, a terminal full stop when
  they never use one, an emoji when they effectively never use one.
- `fabrication_gate` — **the highest-severity one.** A date, time, place, amount or
  name that is not in `gist.facts` is an invented commitment sent to a friend in the
  user's own name.
- `forbidden_phrase` — assistant-speak. In a text to your roommate it is worse than no
  draft at all.
- `stance_collision` — two candidates with the same stance is a fake choice.

**This module refuses; it never rewrites.** The drafter retries with the failures named,
once, and then ships zero candidates. A brief with no draft is fine. A brief with a bad
draft is a trust event.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

from boi_intel.contracts import FORBIDDEN_PHRASES
from boi_intel.facts import extract_facts
from boi_intel.prompts import hours_stale
from boi_intel.register import EMOJI

# CONTRACTS.md and prompt 04: extend this list, never shorten it. Everything below is
# phrasing that belongs in a support ticket, not in a text to somebody you know.
#
# Deliberately NOT added, despite being tempting: "feel free to", "in the meantime",
# "no worries at all", "cheers". Real people text those. Over-blocking does not produce
# a safer draft, it produces zero drafts, and zero drafts every morning is a dead
# product rather than a careful one.
EXTRA_FORBIDDEN_PHRASES = (
    "hope you're doing well",
    "hope you are doing well",
    "hope all is well",
    "hope this message finds you",
    "following up on",
    "per my last",
    "i wanted to reach out",
    "wanted to reach out",
    "happy to help",
    "let me know if you have any questions",
    "thank you for your patience",
    "thanks for your patience",
    "looking forward to hearing from you",
    "as discussed",
    "kind regards",
    "sincerely,",
    "regards,",
    "i apologize for any inconvenience",
    "apologies for any inconvenience",
    "please do not hesitate",
    "don't hesitate to reach out",
    "i trust this",
    "noted with thanks",
    "as per",
)

ALL_FORBIDDEN_PHRASES = tuple(FORBIDDEN_PHRASES) + EXTRA_FORBIDDEN_PHRASES

# CONTRACTS.md § "The length gate, corrected 2 Aug".
#
#     limit = max(median_len_chars * avg_msgs_per_burst, p90_len_chars) + 30
#
# Prompt 04 originally said "within 2× the median", and that was too tight: it rejected
# the project's own reference drafts. The median is computed over every sent message
# including "ok" and "lol"; a draft has to acknowledge the silence *and* answer, which is
# structurally two clauses; and the register already records how many messages this user
# sends at a time, so a single draft standing in for a burst is legitimately longer.
# The `+ 30` is the apology opener, which costs about that much before the answer starts.
#
# For the Maya pack (median 34, p90 88, burst 2.3) this is 118 — a 79-character defer
# passes and the 300-character paragraph the gate exists to catch still fails by a wide
# margin. The tell was never 2×; it was closer to 9×.
APOLOGY_OPENER_ALLOWANCE = 30

# Prompt 04: "no emoji if their rate is under 2%."
EMOJI_RATE_FLOOR = 0.02

LOWERCASE_REGISTERS = ("lowercase_no_period", "lowercase_period")
NO_PERIOD_REGISTERS = ("lowercase_no_period", "sentence_case_no_period")

_WORD = re.compile(r"[a-z0-9']+")


def _normalise(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip().lower()


# ---------------------------------------------------------------------- the gates


def length_limit(register: dict) -> float:
    """`max(median * avg_msgs_per_burst, p90) + 30`, per CONTRACTS.md.

    Every term is already in the register, so the gate adapts to the writer rather than
    to a constant: somebody who fires off four fragments gets a larger allowance than
    somebody who sends one considered message, which is the actual difference the gate
    is trying to respect.
    """
    median = register.get("median_len_chars") or 1
    burst = register.get("avg_msgs_per_burst") or 1.0
    p90 = register.get("p90_len_chars") or median
    return max(median * burst, p90) + APOLOGY_OPENER_ALLOWANCE


def length_failures(candidates: list[dict], register: dict) -> bool:
    """True if any candidate is longer than `length_limit`.

    A 300-character paragraph from somebody who writes 34 characters is the single most
    obvious tell that a machine wrote it.
    """
    limit = length_limit(register)
    return any(len(c["text"]) > limit for c in candidates)


def register_failures(candidates: list[dict], register: dict) -> bool:
    """Capitalisation, terminal full stop, emoji. What people notice instantly."""
    punctuation = register.get("punctuation", "mixed")
    emoji_rate = register.get("emoji_rate", 0.0)

    for c in candidates:
        text = c["text"].strip()
        if not text:
            continue

        if punctuation in LOWERCASE_REGISTERS:
            first = next((ch for ch in text if ch.isalpha()), None)
            if first is not None and first.isupper():
                return True

        if punctuation in NO_PERIOD_REGISTERS and text.endswith("."):
            return True

        if emoji_rate < EMOJI_RATE_FLOOR and EMOJI.search(text):
            return True

    return False


#: Vague temporal hedges, which are NOT specifics — CONTRACTS.md § 1, decided 3 Aug:
#: "a specific is falsifiable against a calendar; a hedge is not", and "a closed
#: allowlist of hedges passes without needing a match in `facts`".
#:
#: **That ruling was never implemented.** `facts.RELATIVE_DAYS` extracts `this week` as a
#: date, so the canonical `defer` candidate — `"ill get back to u this week"`, the exact
#: string CONTRACTS quotes — failed `fabrication_gate` on every run with an empty
#: allowlist, which is the 5% ceiling the contract says nobody could reach. Found while
#: writing the staleness tests, because that string is what a hedged draft looks like.
#:
#: Implemented here rather than in `facts.py` on purpose: extraction should keep seeing
#: these (the gist's own `facts` may legitimately carry "this week" from the other
#: person's message), and it is the GATE that must not treat them as commitments.
#:
#: Closed and short, as instructed. Anything naming a day, a date, a time or a number
#: stays gated — `tomorrow` and `the weekend` are commitments and are deliberately absent.
HEDGES = frozenset(
    {
        "this week",
        "next week",
        "this month",
        "next month",
        "soon",
        "later",
        "sometime",
        "in a bit",
        "a while",
    }
)


def fabricated_specifics(text: str, facts: dict) -> list[str]:
    """Every specific in `text` that `gist.facts` does not license.

    Extraction reuses `facts.extract_facts`, so the gate recognises exactly the same
    shapes the allowlist was built from. Using a different extractor on each side would
    guarantee disagreement: the gist would license "the 14th" and the gate would object
    to "14th".

    Containment counts in both directions, but only when it is **anchored on token
    boundaries** — a draft saying "14th" against a licensed "the 14th" is naming the
    same day, whereas "$12" against a licensed "$120" is a different number.

    Bare substring matching got this catastrophically wrong: every prefix of a licensed
    specific was licensed, so a gist recording that somebody is owed **$120** licensed a
    draft committing to **$12**. That is the gate itself generating a wrong commitment in
    the user's own name, which is worse than the invented ones it exists to stop —
    an invented number is at least obviously unfamiliar, while a plausible wrong one gets
    sent.
    """
    allowed = [
        _normalise(v)
        for key in ("dates", "times", "places", "amounts", "names")
        for v in facts.get(key, [])
    ]
    found = extract_facts([text])

    unlicensed: list[str] = []
    for key in ("dates", "times", "places", "amounts", "names"):
        for value in found.get(key, []):
            norm = _normalise(value)
            if norm in HEDGES:
                continue
            if any(_licenses(a, norm) for a in allowed):
                continue
            unlicensed.append(value)
    return unlicensed


def _token_aligned(needle: str, haystack: str) -> bool:
    """`needle` occurs in `haystack` bounded by non-word characters on both sides.

    "12" is token-aligned in "$12 total" and NOT in "$120", which is the whole point.
    """
    if not needle:
        return False
    return re.search(rf"(?<!\w){re.escape(needle)}(?!\w)", haystack) is not None


def _licenses(licensed: str, found: str) -> bool:
    """Does an allowlisted specific license this one? Both already normalised."""
    if licensed == found:
        return True
    return _token_aligned(found, licensed) or _token_aligned(licensed, found)


def fabrication_failures(candidates: list[dict], gist: dict) -> bool:
    facts = gist.get("facts", {})
    return any(fabricated_specifics(c["text"], facts) for c in candidates)


def forbidden_phrases_in(text: str) -> list[str]:
    low = text.lower()
    return [p for p in ALL_FORBIDDEN_PHRASES if p in low]


def forbidden_phrase_failures(candidates: list[dict]) -> bool:
    return any(forbidden_phrases_in(c["text"]) for c in candidates)


# ------------------------------------------------------------- stale present tense
#
# `BOI_ARCHITECTURE.md` § 6.6 asks for two things: `as_of` in every prompt, and a system
# instruction forbidding present-tense claims about stale state. `prompts.py` now does
# both — and an instruction is a request, not a guarantee. This is the guarantee.
#
# The failure it stops: `days_silent` is computed when the digest is built, so a Mac
# closed for four days tells the model "3 days" and the model writes "sorry, been 3 days"
# into a message the USER sends in their own name, on day seven. That is a plausible
# WRONG commitment — the class CONTRACTS.md § 6 puts under "degrade, never fabricate",
# and strictly worse than an obviously-invented one because it gets sent.
#
# It reports as `stale_tense_gate`, its own slug. It rode on `fabrication_gate` for one
# commit while `draft_bundle.v1.validator.failures` was a frozen enum this track could not
# widen; the user ruled to widen it, on the grounds that a failure list which cannot
# distinguish a stale-tense refusal from a fabrication refusal has lost the information it
# exists to carry. The two really are different defects: one names a specific the gist
# never carried, the other repeats a specific the gist carried *and that has since
# expired*.

#: Beyond this, a day count is a claim about the past wearing the present tense.
STALE_CLAIM_HOURS = 24.0

#: "3 days", "3d", "two weeks". Spelled-out small numbers included because the fact
#: extractor famously does not catch them and this is the same blind spot.
_SPELLED = "one|two|three|four|five|six|seven|eight|nine|ten|a couple of|a few"
_DAY_COUNT = re.compile(
    rf"\b(?:\d{{1,3}}|{_SPELLED})\s*(?:d|w|day|days|week|weeks|month|months)\b",
    re.IGNORECASE,
)


def stale_claim_failures(candidates: list[dict], gist: dict, now=None) -> bool:
    """True if a candidate states a bare day count while the gist is stale.

    Vague hedges are untouched on purpose — "a while", "ages", "too long" commit to
    nothing checkable, which is exactly what a stale draft should do. CONTRACTS.md § 1
    already draws that line for the fabrication gate and this is the same line.
    """
    if hours_stale(gist.get("as_of"), now) < STALE_CLAIM_HOURS:
        return False
    return any(_DAY_COUNT.search(c.get("text", "") or "") for c in candidates)


# ------------------------------------------------------------------- the verdict


def validate_candidates(
    candidates: list[dict], gist: dict, voice_pack: dict, now=None
) -> list[str]:
    """Failure slugs for one set of candidates, in the frozen vocabulary.

    An empty list means every gate passed. Order is fixed so two runs over the same
    input produce byte-identical `validator.failures`.
    """
    register = voice_pack.get("register", {})
    failures: list[str] = []

    usable = [c for c in candidates if c.get("text", "").strip()]
    if len(candidates) != 2 or len(usable) != 2:
        failures.append("empty")
        # Without two usable candidates the remaining gates have nothing to say.
        return failures

    if length_failures(usable, register):
        failures.append("length_gate")
    if register_failures(usable, register):
        failures.append("register_gate")
    if fabrication_failures(usable, gist):
        failures.append("fabrication_gate")
    if stale_claim_failures(usable, gist, now):
        failures.append("stale_tense_gate")
    if forbidden_phrase_failures(usable):
        failures.append("forbidden_phrase")
    if usable[0]["stance"] == usable[1]["stance"]:
        failures.append("stance_collision")

    return failures


def explain(candidates: list[dict], gist: dict, voice_pack: dict) -> dict:
    """A human-readable account of the verdict, for the CLI and for reports.

    Carries candidate text, so it is a developer tool — never a log line.
    """
    register = voice_pack.get("register", {})
    limit = length_limit(register)
    detail = []
    for c in candidates:
        text = c.get("text", "")
        detail.append(
            {
                "stance": c.get("stance"),
                "chars": len(text),
                "length_limit": limit,
                "over_length": len(text) > limit,
                "forbidden_phrases": forbidden_phrases_in(text),
                "unlicensed_specifics": fabricated_specifics(text, gist.get("facts", {})),
            }
        )
    failures = validate_candidates(candidates, gist, voice_pack)
    return {"passed": not failures, "failures": failures, "candidates": detail}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m boi_intel.validator",
        description="Judge a draft_bundle.v1 against a gist.v1 and a voice_pack.v1.",
    )
    ap.add_argument("--bundle", required=True, help="a draft_bundle.v1 document")
    ap.add_argument("--gist", required=True, help="the gist.v1 it was drafted from")
    ap.add_argument("--voice-pack", required=True, help="the voice_pack.v1 it was drafted from")
    a = ap.parse_args(argv)

    bundle = json.loads(pathlib.Path(a.bundle).read_text())
    gist = json.loads(pathlib.Path(a.gist).read_text())
    voice_pack = json.loads(pathlib.Path(a.voice_pack).read_text())

    report = explain(bundle.get("candidates", []), gist, voice_pack)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
