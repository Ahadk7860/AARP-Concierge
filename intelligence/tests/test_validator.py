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

import pytest
from boi_intel.contracts import FORBIDDEN_PHRASES, VALIDATOR_FAILURES
from boi_intel.draft import draft
from boi_intel.prompts import parse_candidates, retry_note
from boi_intel.validator import (
    ALL_FORBIDDEN_PHRASES,
    EMOJI_RATE_FLOOR,
    EXTRA_FORBIDDEN_PHRASES,
    LENGTH_MULTIPLE,
    explain,
    fabricated_specifics,
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


def test_a_draft_at_2_1x_the_median_is_rejected():
    over = "x" * int(MEDIAN * 2.1)
    assert "length_gate" in validate_candidates(_pair(over, "ok"), MAYA_GIST, MAYA_PACK)


def test_a_draft_at_1_9x_the_median_passes_the_length_gate():
    under = "x" * int(MEDIAN * 1.9)
    assert "length_gate" not in validate_candidates(_pair(under, "ok"), MAYA_GIST, MAYA_PACK)


def test_the_length_limit_is_two_times_the_median():
    assert LENGTH_MULTIPLE == 2.0
    at_limit = "x" * (MEDIAN * 2)
    just_over = "x" * (MEDIAN * 2 + 1)
    assert "length_gate" not in validate_candidates(_pair(at_limit, "ok"), MAYA_GIST, MAYA_PACK)
    assert "length_gate" in validate_candidates(_pair(just_over, "ok"), MAYA_GIST, MAYA_PACK)


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


# ---------------------------------------------------------------- the contract gap


def test_maya_pass_fixture_fails_two_gates_CONTRACT_GAP():
    """**This test documents a conflict between two frozen artifacts, not a bug here.**

    Prompt 04 requires `contracts/fixtures/draft_bundle/maya_pass.json` to pass every
    gate, and that fixture declares `validator.passed = true`. It does not pass, for two
    independent reasons, and both come from implementing the prompt exactly as written:

    1. `forbidden_phrase` — its `answer` candidate contains U+2014 EM DASH, and the
       frozen `contracts.FORBIDDEN_PHRASES` lists the em dash. Prompt 04 says to extend
       that list and never shorten it, so the em dash cannot be dropped here.
    2. `length_gate` — its `defer` candidate is 79 characters against a limit of
       2 x 34 = 68, where 34 is `maya.json`'s own `median_len_chars`.

    Softening either gate to make the fixture green is exactly what prompt 04 forbids:
    "If a gate is wrong, that is a finding for NOTES.md, not an edit."

    **Delete this test once the user resolves the gap** — it will start failing the
    moment either artifact is corrected, which is the intended prompt to remove it.
    """
    bundle = json.loads((FIXTURES / "draft_bundle" / "maya_pass.json").read_text())
    failures = validate_candidates(bundle["candidates"], MAYA_GIST, MAYA_PACK)

    assert failures == ["length_gate", "forbidden_phrase"], failures
    assert bundle["validator"]["passed"] is True, "the fixture claims it passed"

    report = explain(bundle["candidates"], MAYA_GIST, MAYA_PACK)
    assert report["candidates"][0]["forbidden_phrases"] == ["—"]
    assert report["candidates"][1]["over_length"] is True


def test_the_recorded_good_transcripts_also_carry_an_em_dash():
    """The same conflict, one layer down: the `maya_action_needed` and `yu_fading`
    transcripts are the recorded *good* model output, and both contain an em dash. So
    the drafter's happy path degrades to zero candidates under a literal reading of the
    frozen phrase list. Reported, not worked around."""
    for name in ("maya_action_needed", "yu_fading"):
        text = " ".join(c["text"] for c in _transcript(name))
        assert "—" in text, name


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
