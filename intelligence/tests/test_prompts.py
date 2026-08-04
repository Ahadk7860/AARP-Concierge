"""The staleness rule, which no track could have built.

`BOI_ARCHITECTURE.md` § 6.6 requires "`as_of` in every prompt, and a system instruction
forbidding present-tense claims about stale state", and § 8 calls staleness "structurally
impossible to lose". The rule never reached `CONTRACTS.md`, which is the document every
track actually built against, so `prompts.py` contained the string `as_of` zero times and
`SYSTEM` had five rules, none about tense.

These tests are about the PROMPT. The enforcement — a gate that bites whatever the model
does — is in `test_validator.py`, because an instruction is a request and a user's own
name is on the message either way.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from boi_intel.prompts import (
    PROMPT_VERSION_DEFAULT,
    STALE_AFTER_HOURS,
    SYSTEM,
    hours_stale,
    render_gist,
)

NOW = datetime(2026, 8, 8, 12, 0, tzinfo=UTC)


def gist(as_of: str, **over) -> dict:
    base = {
        "gist_id": "g_0123456789ab",
        "gist": "they asked you something 3 days ago and you have not replied",
        "state": "action_needed",
        "days_silent": 3,
        "unanswered_question": True,
        "as_of": as_of,
        "facts": {"dates": [], "times": [], "places": [], "amounts": [], "names": []},
    }
    base.update(over)
    return base


def test_every_prompt_carries_as_of():
    rendered = render_gist(gist("2026-08-08T11:00:00Z"), now=NOW)
    assert "as of: 2026-08-08T11:00:00Z" in rendered
    # And it says what the timestamp MEANS. A bare ISO string in a prompt is decoration.
    assert "measured then, not now" in rendered


def test_the_system_prompt_forbids_present_tense_claims_about_stale_state():
    assert "as of" in SYSTEM.lower()
    assert "present tense" in SYSTEM.lower()
    # The remedy is named, not just the prohibition: a rule with no alternative is a rule
    # a model routes around.
    assert "a while" in SYSTEM.lower()


def test_a_stale_gist_is_marked_stale_and_a_fresh_one_is_not():
    fresh = render_gist(gist("2026-08-08T11:00:00Z"), now=NOW)
    stale = render_gist(gist("2026-08-04T12:00:00Z"), now=NOW)
    assert "STALE" not in fresh
    assert "STALE: these measurements are about 4 day(s) old" in stale
    assert "Do NOT state any day count" in stale


def test_hours_stale_fails_TOWARDS_stale():
    # Missing or unparseable `as_of` hedges rather than asserts. Wrongly hedging costs a
    # vaguer message; wrongly not hedging tells somebody "sorry, been 3 days" on day
    # seven, in the user's own name.
    assert hours_stale(None, NOW) == float("inf")
    assert hours_stale("not a timestamp", NOW) == float("inf")
    assert hours_stale("2026-08-08T11:00:00Z", NOW) == 1.0
    # Naive timestamps are read as UTC rather than as local time, which would shift the
    # answer by up to a day depending on where the server is.
    assert hours_stale("2026-08-08T11:00:00", NOW) == 1.0


def test_the_threshold_matches_the_hour_the_brief_starts_warning():
    # 24 is `BOI_STALENESS_WARN_HOURS`. Two different thresholds would mean a brief that
    # tells the user its data is old above a confident draft that does not.
    assert STALE_AFTER_HOURS == 24
    boundary = NOW - timedelta(hours=STALE_AFTER_HOURS, seconds=1)
    assert "STALE" in render_gist(gist(boundary.strftime("%Y-%m-%dT%H:%M:%SZ")), now=NOW)


def test_the_prompt_version_moved_when_the_prompt_did():
    # CONTRACTS.md § 6 makes a bad draft reproducible from
    # `(voice_pack_version, gist_id, prompt_version, model_id)` and from nothing else,
    # because the prompt is never logged. Changing SYSTEM under a fixed version string
    # turns that tuple into a lie, and the committed transcripts really are v1 output.
    assert PROMPT_VERSION_DEFAULT == "draft.v2"
