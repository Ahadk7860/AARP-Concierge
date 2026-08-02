"""The validator, which is not a model.

    python -m boi_intel.validator --bundle b.json --gist g.json --voice-pack vp.json

Rules, deterministic, no model. It is not a model because its job is to be **boringly
reliable at refusing**, and a model asked to judge its own family's output grades
gently. Every gate here is arithmetic or a table lookup, so it returns the same verdict
on Tuesday as it did on Monday and a reviewer can work out why by reading it.

Six gates, and the vocabulary is frozen (`contracts.VALIDATOR_FAILURES`):

- `empty` — nothing usable came back.
- `length_gate` — more than 2× the user's median message length.
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

# Prompt 04: "within 2× the user's median message length for that contact."
LENGTH_MULTIPLE = 2.0

# Prompt 04: "no emoji if their rate is under 2%."
EMOJI_RATE_FLOOR = 0.02

LOWERCASE_REGISTERS = ("lowercase_no_period", "lowercase_period")
NO_PERIOD_REGISTERS = ("lowercase_no_period", "sentence_case_no_period")

_WORD = re.compile(r"[a-z0-9']+")


def _normalise(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip().lower()


# ---------------------------------------------------------------------- the gates


def length_failures(candidates: list[dict], register: dict) -> bool:
    """True if any candidate is more than 2× the user's median.

    A 300-character paragraph from somebody who writes 34 characters is the single most
    obvious tell that a machine wrote it.
    """
    median = register.get("median_len_chars") or 1
    limit = median * LENGTH_MULTIPLE
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


def fabricated_specifics(text: str, facts: dict) -> list[str]:
    """Every specific in `text` that `gist.facts` does not license.

    Extraction reuses `facts.extract_facts`, so the gate recognises exactly the same
    shapes the allowlist was built from. Using a different extractor on each side would
    guarantee disagreement: the gist would license "the 14th" and the gate would object
    to "14th".

    Containment counts in both directions — a draft saying "14th" against a licensed
    "the 14th" is naming the same day, not inventing one.
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
            if any(norm in a or a in norm for a in allowed):
                continue
            unlicensed.append(value)
    return unlicensed


def fabrication_failures(candidates: list[dict], gist: dict) -> bool:
    facts = gist.get("facts", {})
    return any(fabricated_specifics(c["text"], facts) for c in candidates)


def forbidden_phrases_in(text: str) -> list[str]:
    low = text.lower()
    return [p for p in ALL_FORBIDDEN_PHRASES if p in low]


def forbidden_phrase_failures(candidates: list[dict]) -> bool:
    return any(forbidden_phrases_in(c["text"]) for c in candidates)


# ------------------------------------------------------------------- the verdict


def validate_candidates(candidates: list[dict], gist: dict, voice_pack: dict) -> list[str]:
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
    median = register.get("median_len_chars") or 1
    detail = []
    for c in candidates:
        text = c.get("text", "")
        detail.append(
            {
                "stance": c.get("stance"),
                "chars": len(text),
                "length_limit": median * LENGTH_MULTIPLE,
                "over_length": len(text) > median * LENGTH_MULTIPLE,
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
