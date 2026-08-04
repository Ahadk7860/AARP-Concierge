"""The validator's gates, and the degraded outcome.

Every gate is tested on purpose-built input rather than only on fixtures, because a
gate that happens to agree with one fixture is not a gate. The two committed violation
transcripts exist specifically to be rejected — if either passed, the whole thing would
be decoration.

One test in here documents a **conflict between two frozen artifacts** rather than a
property of this code: see `test_maya_pass_fixture_fails_two_gates_CONTRACT_GAP`.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
from datetime import UTC, datetime

import pytest
from boi_intel.contracts import FORBIDDEN_PHRASES, VALIDATOR_FAILURES
from boi_intel.draft import draft
from boi_intel.prompts import parse_candidates, retry_note
from boi_intel.validator import (
    ALL_FORBIDDEN_PHRASES,
    APOLOGY_OPENER_ALLOWANCE,
    EMOJI_RATE_FLOOR,
    EXTRA_FORBIDDEN_PHRASES,
    explain,
    fabricated_specifics,
    length_limit,
    validate_candidates,
)

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "contracts" / "fixtures"
TRANSCRIPTS = ROOT / "contracts" / "transcripts" / "model"

MAYA_PACK = json.loads((FIXTURES / "voice_pack" / "maya.json").read_text())
MAYA_GIST = json.loads((FIXTURES / "gist" / "maya_action_needed.json").read_text())

EMPTY_FACTS = {"dates": [], "times": [], "places": [], "amounts": [], "names": []}
NO_FACTS_GIST = dict(MAYA_GIST, gist_id="g_99ff00aa", facts=EMPTY_FACTS)

# maya.json: median_len_chars = 34, punctuation = lowercase_no_period, emoji_rate = 0.11
MEDIAN = MAYA_PACK["register"]["median_len_chars"]


def _pair(answer: str, defer: str) -> list[dict]:
    return [{"stance": "answer", "text": answer}, {"stance": "defer", "text": defer}]


def _transcript(name: str) -> list[dict]:
    rec = json.loads((TRANSCRIPTS / f"{name}.json").read_text())
    return parse_candidates(rec["response"])


# ------------------------------------------- the transcripts that exist to violate


def test_the_fabrication_transcript_is_rejected_with_fabrication_gate():
    """'yes im free thursday at 7' against a gist whose facts contain no Thursday and
    no 7. If this passes, the gate is decoration."""
    failures = validate_candidates(_transcript("fabrication_violation"), NO_FACTS_GIST, MAYA_PACK)
    assert "fabrication_gate" in failures, failures


def test_the_fabrication_transcript_names_exactly_what_it_invented():
    candidates = _transcript("fabrication_violation")
    unlicensed = fabricated_specifics(candidates[0]["text"], EMPTY_FACTS)
    lowered = [u.lower() for u in unlicensed]
    assert "thursday" in lowered, unlicensed
    assert "7" in lowered, unlicensed


def test_the_assistant_speak_transcript_is_rejected_with_forbidden_phrase():
    failures = validate_candidates(_transcript("assistant_speak_violation"), MAYA_GIST, MAYA_PACK)
    assert "forbidden_phrase" in failures, failures


def test_the_assistant_speak_transcript_trips_the_phrases_it_was_built_from():
    report = explain(_transcript("assistant_speak_violation"), MAYA_GIST, MAYA_PACK)
    hits = {p for c in report["candidates"] for p in c["forbidden_phrases"]}
    assert "just circling back" in hits
    assert "i hope this finds you well" in hits


# ------------------------------------------------------------------- length gate


def test_the_length_limit_follows_the_amended_formula():
    """`max(median * avg_msgs_per_burst, p90) + 30`. For the Maya pack that is
    max(34 * 2.3, 88) + 30 = 118."""
    assert length_limit(MAYA_PACK["register"]) == 118
    assert APOLOGY_OPENER_ALLOWANCE == 30


def test_a_draft_at_the_limit_passes_and_one_character_over_fails():
    limit = int(length_limit(MAYA_PACK["register"]))
    assert "length_gate" not in validate_candidates(_pair("x" * limit, "ok"), MAYA_GIST, MAYA_PACK)
    assert "length_gate" in validate_candidates(
        _pair("x" * (limit + 1), "ok"), MAYA_GIST, MAYA_PACK
    )


def test_the_paragraph_the_gate_exists_to_catch_still_fails_by_a_wide_margin():
    """The tell was never 2x; it was closer to 9x. A 300-character paragraph from
    somebody who writes 34 characters must still be refused."""
    paragraph = "so anyway " * 30  # 300 chars
    assert len(paragraph) == 300
    assert "length_gate" in validate_candidates(_pair(paragraph, "ok"), MAYA_GIST, MAYA_PACK)


def test_the_reference_defer_draft_of_79_chars_passes():
    """The regression that forced the amendment: this is the project's own reference
    draft, and the old 2x median limit of 68 rejected it."""
    bundle = json.loads((FIXTURES / "draft_bundle" / "maya_pass.json").read_text())
    defer = next(c for c in bundle["candidates"] if c["stance"] == "defer")
    assert len(defer["text"]) == 79
    assert "length_gate" not in validate_candidates(bundle["candidates"], MAYA_GIST, MAYA_PACK)


def test_a_burstier_writer_gets_a_larger_allowance():
    """The gate adapts to the writer: somebody who fires off four fragments is
    legitimately longer in one draft than somebody who sends one considered message."""
    calm = json.loads(json.dumps(MAYA_PACK))
    calm["register"]["avg_msgs_per_burst"] = 1.0
    bursty = json.loads(json.dumps(MAYA_PACK))
    bursty["register"]["avg_msgs_per_burst"] = 4.0
    assert length_limit(bursty["register"]) > length_limit(calm["register"])


# ----------------------------------------------------------------- register gate


def test_a_capital_first_letter_is_rejected_for_a_lowercase_writer():
    assert MAYA_PACK["register"]["punctuation"] == "lowercase_no_period"
    assert "register_gate" in validate_candidates(
        _pair("Yeah im in", "lmk tmrw"), MAYA_GIST, MAYA_PACK
    )


def test_a_terminal_period_is_rejected_for_a_no_period_writer():
    assert "register_gate" in validate_candidates(
        _pair("yeah im in.", "lmk tmrw"), MAYA_GIST, MAYA_PACK
    )


def test_a_matching_register_passes():
    assert validate_candidates(_pair("yeah im in", "lmk tmrw"), MAYA_GIST, MAYA_PACK) == []


def test_an_emoji_is_rejected_when_the_user_effectively_never_uses_one():
    quiet = json.loads(json.dumps(MAYA_PACK))
    quiet["register"]["emoji_rate"] = 0.0
    assert "register_gate" in validate_candidates(_pair("yeah im in 😭", "lmk"), MAYA_GIST, quiet)


def test_an_emoji_is_allowed_when_the_user_does_use_them():
    assert MAYA_PACK["register"]["emoji_rate"] >= EMOJI_RATE_FLOOR
    assert "register_gate" not in validate_candidates(
        _pair("yeah im in 😭", "lmk tmrw"), MAYA_GIST, MAYA_PACK
    )


def test_a_mid_sentence_period_is_not_a_terminal_period():
    """ "been slammed. still figuring it out" is how people text. Only the final
    character counts."""
    assert "register_gate" not in validate_candidates(
        _pair("been slammed. still on for it", "lmk tmrw"), MAYA_GIST, MAYA_PACK
    )


# -------------------------------------------------------------- fabrication gate


def test_a_specific_that_is_in_facts_passes():
    """The Maya gist licenses 'the 14th'."""
    assert "the 14th" in MAYA_GIST["facts"]["dates"]
    assert "fabrication_gate" not in validate_candidates(
        _pair("yes im still coming on the 14th", "lmk tmrw"), MAYA_GIST, MAYA_PACK
    )


def test_a_licensed_date_may_be_named_in_a_shorter_form():
    """'14th' against a licensed 'the 14th' is the same day, not an invention."""
    assert fabricated_specifics("still on for the 14th", MAYA_GIST["facts"]) == []
    assert fabricated_specifics("still on for 14th", MAYA_GIST["facts"]) == []


def test_an_unlicensed_date_is_caught():
    assert fabricated_specifics("see you on the 23rd", MAYA_GIST["facts"])


def test_an_unlicensed_time_is_caught():
    assert fabricated_specifics("lets say 7pm", MAYA_GIST["facts"])


def test_an_unlicensed_amount_is_caught():
    assert fabricated_specifics("ill venmo you $40", MAYA_GIST["facts"])


def test_an_unlicensed_person_is_caught():
    assert fabricated_specifics("ill bring john smith", MAYA_GIST["facts"])


def test_a_draft_with_no_specifics_at_all_passes_the_fabrication_gate():
    assert fabricated_specifics("sorry been mia, im in", EMPTY_FACTS) == []


def test_the_gate_and_the_allowlist_use_the_same_extractor():
    """A different extractor on each side would license 'the 14th' and then object to
    '14th'. Same module, so they cannot disagree."""
    from boi_intel.facts import extract_facts

    licensed = extract_facts(["are you still coming on the 14th"])
    assert fabricated_specifics("still coming on the 14th", licensed) == []


# ------------------------------------------------------------- forbidden phrases


def test_the_extended_list_is_a_superset_of_the_frozen_one():
    """Prompt 04 and CONTRACTS.md: extend, never shorten."""
    for phrase in FORBIDDEN_PHRASES:
        assert phrase in ALL_FORBIDDEN_PHRASES, phrase
    assert len(ALL_FORBIDDEN_PHRASES) > len(FORBIDDEN_PHRASES)
    assert EXTRA_FORBIDDEN_PHRASES


@pytest.mark.parametrize("phrase", FORBIDDEN_PHRASES)
def test_every_frozen_forbidden_phrase_is_actually_enforced(phrase):
    candidates = _pair(f"hey {phrase} ok", "lmk tmrw")
    assert "forbidden_phrase" in validate_candidates(candidates, MAYA_GIST, MAYA_PACK), phrase


@pytest.mark.parametrize("phrase", EXTRA_FORBIDDEN_PHRASES)
def test_every_added_forbidden_phrase_is_actually_enforced(phrase):
    candidates = _pair(f"hey {phrase} ok", "lmk tmrw")
    assert "forbidden_phrase" in validate_candidates(candidates, MAYA_GIST, MAYA_PACK), phrase


@pytest.mark.parametrize(
    "text",
    [
        "sorry been mia, im in",
        "lmk when ur free and ill come thru",
        "no worries at all",
        "ok that works for me",
        "cheers",
    ],
)
def test_ordinary_texting_is_not_flagged_as_assistant_speak(text):
    """Over-blocking does not produce a safer draft, it produces zero drafts."""
    from boi_intel.validator import forbidden_phrases_in

    assert forbidden_phrases_in(text) == [], text


# ------------------------------------------------------------- stance collision


def test_two_answers_are_rejected_with_stance_collision():
    both = [
        {"stance": "answer", "text": "yeah im in"},
        {"stance": "answer", "text": "yes im coming"},
    ]
    assert "stance_collision" in validate_candidates(both, MAYA_GIST, MAYA_PACK)


def test_one_candidate_is_empty_not_a_collision():
    single = [{"stance": "answer", "text": "yeah im in"}]
    assert validate_candidates(single, MAYA_GIST, MAYA_PACK) == ["empty"]


def test_blank_text_is_empty():
    assert validate_candidates(_pair("   ", "lmk"), MAYA_GIST, MAYA_PACK) == ["empty"]


# -------------------------------------------------------------------- vocabulary


def test_every_failure_slug_is_in_the_frozen_enum():
    cases = [
        _pair("x" * 500, "ok"),
        _pair("Yeah.", "lmk"),
        _pair("see you on the 23rd at 7pm", "lmk"),
        _pair("just circling back", "lmk"),
        [{"stance": "answer", "text": "a"}, {"stance": "answer", "text": "b"}],
        [],
    ]
    for candidates in cases:
        for slug in validate_candidates(candidates, MAYA_GIST, MAYA_PACK):
            assert slug in VALIDATOR_FAILURES, slug


def test_the_verdict_is_deterministic():
    candidates = _pair("x" * 500, "Yeah.")
    first = validate_candidates(candidates, MAYA_GIST, MAYA_PACK)
    for _ in range(5):
        assert validate_candidates(candidates, MAYA_GIST, MAYA_PACK) == first


# ------------------------------------------------------------------- degradation


class AlwaysBad:
    """A model that will not stop writing like an assistant."""

    model_id = "always-bad"

    def __init__(self) -> None:
        self.calls = 0
        self.suffixes: list[str] = []

    def complete(self, system, cached_prefix, suffix):
        self.calls += 1
        self.suffixes.append(suffix)
        return json.dumps(
            {
                "candidates": [
                    {"stance": "answer", "text": "Hi! Just circling back on this."},
                    {"stance": "defer", "text": "Apologies for the delay. Best,"},
                ]
            }
        )


def test_two_failed_attempts_degrade_to_zero_candidates():
    model = AlwaysBad()
    bundle = draft(MAYA_PACK, MAYA_GIST, provider=model, as_of="2026-08-01T00:00:00Z")

    assert model.calls == 2, "one try, one retry"
    assert bundle.candidates == []
    assert bundle.validator.passed is False
    assert bundle.validator.attempts == 2
    assert bundle.validator.failures, "the reasons must be recorded, not discarded"
    for slug in bundle.validator.failures:
        assert slug in VALIDATOR_FAILURES


def test_degradation_returns_rather_than_raising():
    """A brief with no draft is fine. An exception on the morning path is not."""
    bundle = draft(MAYA_PACK, MAYA_GIST, provider=AlwaysBad(), as_of="2026-08-01T00:00:00Z")
    assert bundle is not None
    assert bundle.candidates == []


def test_the_degraded_bundle_validates_against_the_schema(tmp_path):
    bundle = draft(MAYA_PACK, MAYA_GIST, provider=AlwaysBad(), as_of="2026-08-01T00:00:00Z")
    path = tmp_path / "degraded.json"
    path.write_text(json.dumps(bundle.to_dict(), indent=2, ensure_ascii=False))

    r = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "validate_fixtures.py"),
            "draft_bundle.v1",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr


def test_the_retry_names_the_failures():
    """Prompt 04: retry with the failures named. A blind retry is a coin flip."""
    model = AlwaysBad()
    draft(MAYA_PACK, MAYA_GIST, provider=model, as_of="2026-08-01T00:00:00Z")

    first, second = model.suffixes
    assert "YOUR PREVIOUS ATTEMPT WAS REJECTED" not in first
    assert "YOUR PREVIOUS ATTEMPT WAS REJECTED" in second
    assert "assistant" in second.lower()


def test_retry_note_is_empty_when_nothing_failed():
    assert retry_note([]) == ""


def test_retry_note_covers_every_failure_slug():
    for slug in VALIDATOR_FAILURES:
        note = retry_note([slug])
        assert note.strip(), slug
        assert slug not in note or len(note) > len(slug) + 40, f"{slug} has no guidance"


def test_a_model_that_recovers_on_the_retry_passes():
    class RecoversOnRetry:
        model_id = "recovers"

        def __init__(self):
            self.calls = 0

        def complete(self, system, cached_prefix, suffix):
            self.calls += 1
            if self.calls == 1:
                return json.dumps(
                    {
                        "candidates": [
                            {"stance": "answer", "text": "Hi! Just circling back."},
                            {"stance": "defer", "text": "lmk tmrw"},
                        ]
                    }
                )
            return json.dumps(
                {
                    "candidates": [
                        {"stance": "answer", "text": "sorry been mia, im in"},
                        {"stance": "defer", "text": "can i lmk tmrw"},
                    ]
                }
            )

    bundle = draft(MAYA_PACK, MAYA_GIST, provider=RecoversOnRetry(), as_of="2026-08-01T00:00:00Z")
    assert bundle.validator.passed is True
    assert bundle.validator.attempts == 2
    assert len(bundle.candidates) == 2


# ------------------------------------------------ the reference bundle, post-fix


def test_maya_pass_fixture_passes_every_gate():
    """The conflict this file used to document is resolved.

    Two frozen artifacts disagreed: the fixture carried an em dash that the frozen
    `FORBIDDEN_PHRASES` forbids, and its defer candidate was 79 chars against the old
    2x34=68 limit. Both were fixed upstream — the em dash removed from the fixture and
    the transcripts, and the length gate respecified in CONTRACTS.md as
    `max(median * avg_msgs_per_burst, p90) + 30`. The two CONTRACT_GAP tests that
    guarded the gap were deleted when it closed, which is what they were for.
    """
    bundle = json.loads((FIXTURES / "draft_bundle" / "maya_pass.json").read_text())
    assert validate_candidates(bundle["candidates"], MAYA_GIST, MAYA_PACK) == []
    assert bundle["validator"]["passed"] is True


def test_no_reference_artifact_carries_an_em_dash():
    """The em dash is the single most reliable machine tell, and the reference drafts
    are what everyone copies. Guards against it creeping back in."""
    for name in ("maya_action_needed", "yu_fading"):
        assert "\u2014" not in " ".join(c["text"] for c in _transcript(name)), name
    bundle = json.loads((FIXTURES / "draft_bundle" / "maya_pass.json").read_text())
    assert "\u2014" not in " ".join(c["text"] for c in bundle["candidates"])


# ---------------------------------------------------------------------------- CLI


def test_the_cli_exits_nonzero_on_a_failing_bundle(tmp_path):
    from boi_intel.validator import main

    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"candidates": _pair("Just circling back.", "lmk")}))

    rc = main(
        [
            "--bundle",
            str(bad),
            "--gist",
            str(FIXTURES / "gist" / "maya_action_needed.json"),
            "--voice-pack",
            str(FIXTURES / "voice_pack" / "maya.json"),
        ]
    )
    assert rc == 1


def test_the_cli_exits_zero_on_a_passing_bundle(tmp_path):
    from boi_intel.validator import main

    good = tmp_path / "good.json"
    good.write_text(json.dumps({"candidates": _pair("sorry been mia, im in", "can i lmk tmrw")}))

    rc = main(
        [
            "--bundle",
            str(good),
            "--gist",
            str(FIXTURES / "gist" / "maya_action_needed.json"),
            "--voice-pack",
            str(FIXTURES / "voice_pack" / "maya.json"),
        ]
    )
    assert rc == 0


# ---- PASS 2: a prefix of a licensed specific is NOT licensed --------------------
# Bare substring containment meant a gist recording $120 licensed a draft committing to
# $12 — the gate generating a WRONG commitment in the user's name, worse than the
# invented ones it exists to stop. Containment is now anchored on token boundaries.


def _facts(**kw):
    return {k: kw.get(k, []) for k in ("dates", "times", "places", "amounts", "names")}


@pytest.mark.parametrize(
    "draft_text,licensed,refused",
    [
        # the reported bug, both directions
        ("ill send you $12", _facts(amounts=["$120"]), True),
        ("ill send you $1200", _facts(amounts=["$120"]), True),
        ("ill send you $120", _facts(amounts=["$120"]), False),
        ("ill pay 12 dollars", _facts(amounts=["120 dollars"]), True),
        ("ill pay 120 dollars", _facts(amounts=["120 dollars"]), False),
        # times are numbers too
        ("see you at 10", _facts(times=["100"]), True),
        ("see you at 10", _facts(times=["10"]), False),
        # the legitimate shortening that must keep working
        ("still on for 14th", _facts(dates=["the 14th"]), False),
        ("still on for the 14th", _facts(dates=["14th"]), False),
        ("see you on the 23rd", _facts(dates=["the 14th"]), True),
    ],
)
def test_a_prefix_of_a_licensed_specific_is_not_licensed(draft_text, licensed, refused):
    assert bool(fabricated_specifics(draft_text, licensed)) is refused


def test_the_licensing_predicate_is_token_anchored():
    from boi_intel.validator import _licenses

    assert _licenses("the 14th", "14th")  # word-boundary aligned: same day
    assert _licenses("14th", "the 14th")
    assert _licenses("friday", "friday")
    assert not _licenses("$120", "$12")  # mid-token: a different number
    assert not _licenses("$12", "$120")
    assert not _licenses("100", "10")
    assert not _licenses("10", "100")


def test_the_money_case_end_to_end_through_the_gate():
    """A draft committing to the wrong amount must degrade to zero candidates."""
    gist = dict(MAYA_GIST, facts=_facts(amounts=["$120"]))
    failures = validate_candidates(
        _pair("ok ill venmo you $12 tonight", "lmk tmrw"), gist, MAYA_PACK
    )
    assert "fabrication_gate" in failures, failures


# --------------------------------------------------------------- prompt 06: staleness
#
# The gate the architecture asked for and no track built, because the rule never reached
# CONTRACTS.md. `prompts.py` now instructs the model; this is what happens when the model
# does not listen, which is the only version of the rule that is worth anything when the
# user's own name is on the message.


def _stale_gist(as_of: str) -> dict:
    return {
        "gist_id": "g_stale0000ab",
        "as_of": as_of,
        "facts": {"dates": [], "times": [], "places": [], "amounts": [], "names": []},
    }


_REGISTER = {
    "median_len_chars": 34,
    "p90_len_chars": 88,
    "avg_msgs_per_burst": 2.3,
    "punctuation": "lowercase_no_period",
    "emoji_rate": 0.0,
}

_NOW = datetime(2026, 8, 8, 12, 0, tzinfo=UTC)


def _pair(answer: str, defer: str) -> list[dict]:
    return [{"stance": "answer", "text": answer}, {"stance": "defer", "text": defer}]


def test_a_day_count_is_rejected_when_the_digest_is_stale():
    # days_silent is computed when the digest is built. A Mac closed for four days hands
    # the model "3", and "sorry been 3 days" goes out in the USER's name on day seven --
    # a plausible WRONG commitment, which CONTRACTS.md section 6 puts under
    # "degrade, never fabricate".
    candidates = _pair("sorry been 3 days, yes im in", "ill get back to u this week")
    failures = validate_candidates(
        candidates, _stale_gist("2026-08-04T12:00:00Z"), {"register": _REGISTER}, _NOW
    )
    # Its OWN slug, not `fabrication_gate`. A failure list that cannot tell a stale-tense
    # refusal from a fabrication refusal has lost the information it exists to carry --
    # they are different defects with different fixes, and `_RETRY_GUIDANCE` steers
    # differently for each.
    assert failures == ["stale_tense_gate"]


def test_the_same_day_count_passes_when_the_digest_is_FRESH():
    # The counter-case, and the reason this is not just a ban on numbers: when the
    # measurement is current, "been 3 days" is true and is exactly what a person writes.
    candidates = _pair("sorry been 3 days, yes im in", "ill get back to u this week")
    failures = validate_candidates(
        candidates, _stale_gist("2026-08-08T11:00:00Z"), {"register": _REGISTER}, _NOW
    )
    assert failures == []


def test_a_hedge_passes_on_a_stale_digest():
    # "a while" cannot be wrong. CONTRACTS.md section 1 already draws this line for the
    # fabrication gate -- a specific is falsifiable against a calendar, a hedge is not --
    # and a gate that rejected the hedge too would leave the model nothing to write.
    candidates = _pair("sorry its been a while, yes im in", "ill get back to u this week")
    failures = validate_candidates(
        candidates, _stale_gist("2026-08-04T12:00:00Z"), {"register": _REGISTER}, _NOW
    )
    assert failures == []


def test_spelled_out_and_abbreviated_counts_are_caught_too():
    # The fact extractor's known blind spot is spelled-out numbers, and this gate would
    # inherit it verbatim if it only matched digits.
    for text in ("sorry been three days", "sorry been 2w", "sorry its been a few weeks"):
        failures = validate_candidates(
            _pair(text, "ill get back to u this week"),
            _stale_gist("2026-08-04T12:00:00Z"),
            {"register": _REGISTER},
            _NOW,
        )
        assert "stale_tense_gate" in failures, text


def test_a_missing_as_of_is_treated_as_stale():
    # Fails towards hedging. A gist with no timestamp is not evidence that the numbers
    # are current.
    failures = validate_candidates(
        _pair("sorry been 3 days, yes im in", "ill get back to u this week"),
        {"gist_id": "g_noasof0000a", "facts": {}},
        {"register": _REGISTER},
        _NOW,
    )
    assert "stale_tense_gate" in failures


def test_the_slug_is_in_the_frozen_vocabulary_and_is_a_WIDENING():
    # The union widened rather than changed: every slug that validated before still
    # validates, which is what makes this safe to do to a frozen enum.
    assert "stale_tense_gate" in VALIDATOR_FAILURES
    for slug in (
        "length_gate",
        "register_gate",
        "fabrication_gate",
        "forbidden_phrase",
        "stance_collision",
        "empty",
    ):
        assert slug in VALIDATOR_FAILURES


def test_a_stale_tense_failure_and_a_fabrication_are_reported_SEPARATELY():
    # One candidate names a date the gist never carried; the same candidate repeats a day
    # count that has since expired. Two defects, two fixes, two slugs.
    candidates = _pair("sorry been 3 days, see u on the 14th", "ill get back to u soon")
    failures = validate_candidates(
        candidates, _stale_gist("2026-08-04T12:00:00Z"), {"register": _REGISTER}, _NOW
    )
    assert "stale_tense_gate" in failures
    assert "fabrication_gate" in failures


def test_the_retry_note_for_a_stale_tense_failure_says_what_to_do_instead():
    # A correction that only names the prohibition is one a model routes around by
    # rephrasing the same claim.
    note = retry_note(["stale_tense_gate"])
    assert "a while" in note
