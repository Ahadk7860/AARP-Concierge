"""The drafter, the router, and the prompt-cache split.

Two properties here are load-bearing beyond "the code works":

- **The cache split is real.** The voice pack must arrive as `cached_prefix` and the
  gist as `suffix`, and the cache key must move with `voice_pack_version` and not with
  the gist. Nominal compliance — three arguments that get concatenated, or a key with
  the gist in it — costs the entire saving and is invisible in output.
- **No prompt text is logged.** A bad draft has to be reproducible from identifiers and
  a hash, without a log full of somebody's messages.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

import pytest
from boi_intel.contracts import FORBIDDEN_PHRASES, VALIDATOR_FAILURES
from boi_intel.draft import MAX_ATTEMPTS, MAX_CANDIDATE_CHARS, draft, main, structural_failures
from boi_intel.prompts import (
    SYSTEM,
    cache_key,
    parse_candidates,
    prompt_hash,
    render_gist,
    render_voice_pack,
)
from boi_intel.providers.fake import FakeProvider
from boi_intel.providers.gemini import GeminiProvider, LiveCallsDisabled
from boi_intel.providers.kimi import KimiProvider
from boi_intel.router import UnknownProvider, provider_names, select_provider
from conftest import NetworkUseInTests

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "contracts" / "fixtures"

MAYA_PACK = json.loads((FIXTURES / "voice_pack" / "maya.json").read_text())
MAYA_GIST = json.loads((FIXTURES / "gist" / "maya_action_needed.json").read_text())
GLOBAL_PACK = json.loads((FIXTURES / "voice_pack" / "global_fallback.json").read_text())
YU_GIST = json.loads((FIXTURES / "gist" / "yu_fading_sql_only.json").read_text())


class Recorder:
    """A provider that records exactly what it was handed."""

    model_id = "recorder"

    def __init__(self, response: str | None = None) -> None:
        self.calls: list[tuple[str, str, str]] = []
        self.response = response or json.dumps(
            {
                "candidates": [
                    {"stance": "answer", "text": "yeah im in, lets do it"},
                    {"stance": "defer", "text": "can i lmk tmrw"},
                ]
            }
        )

    def complete(self, system: str, cached_prefix: str, suffix: str) -> str:
        self.calls.append((system, cached_prefix, suffix))
        return self.response


class Scripted:
    """Returns a queued response per call, so retries can be exercised."""

    model_id = "scripted"

    def __init__(self, *responses: str) -> None:
        self.queue = list(responses)
        self.calls = 0

    def complete(self, system: str, cached_prefix: str, suffix: str) -> str:
        self.calls += 1
        return self.queue.pop(0) if self.queue else "{}"


# ------------------------------------------------------------------ the two drafts


def test_maya_fixture_yields_two_stance_distinct_candidates():
    """Through the real validator, no isolation.

    This briefly needed `validate=None` while the reference transcripts carried an em
    dash the frozen `FORBIDDEN_PHRASES` forbade. That conflict is resolved upstream, so
    the happy path runs end to end through every gate again — which is the assertion
    prompt 03 actually asked for.
    """
    bundle = draft(MAYA_PACK, MAYA_GIST, provider=FakeProvider(), as_of="2026-08-01T00:00:00Z")
    assert bundle.validator.passed is True
    assert bundle.validator.failures == []
    assert len(bundle.candidates) == 2
    assert {c.stance for c in bundle.candidates} == {"answer", "defer"}
    assert bundle.candidates[0].stance != bundle.candidates[1].stance


def test_yu_fixture_yields_two_stance_distinct_candidates():
    bundle = draft(GLOBAL_PACK, YU_GIST, provider=FakeProvider(), as_of="2026-08-01T00:00:00Z")
    assert bundle.validator.passed is True
    assert len(bundle.candidates) == 2
    assert {c.stance for c in bundle.candidates} == {"answer", "defer"}


def test_chars_matches_the_text_length():
    bundle = draft(MAYA_PACK, MAYA_GIST, provider=FakeProvider(), as_of="2026-08-01T00:00:00Z")
    for c in bundle.candidates:
        assert c.chars == len(c.text)


def test_bundle_validates_against_the_frozen_schema(tmp_path):
    bundle = draft(MAYA_PACK, MAYA_GIST, provider=FakeProvider(), as_of="2026-08-01T00:00:00Z")
    path = tmp_path / "bundle.json"
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


def test_model_id_and_prompt_version_are_stamped_on_every_bundle():
    for pack, gist in ((MAYA_PACK, MAYA_GIST), (GLOBAL_PACK, YU_GIST)):
        bundle = draft(pack, gist, provider=FakeProvider(), as_of="2026-08-01T00:00:00Z")
        assert bundle.model_id, "a regression must be attributable to a model"
        assert bundle.prompt_version
        assert bundle.voice_pack_version == pack["voice_pack_version"]
        assert bundle.gist_id == gist["gist_id"]


def test_the_cli_prints_two_candidates(capsys):
    rc = main(
        [
            "--voice-pack",
            str(FIXTURES / "voice_pack" / "maya.json"),
            "--gist",
            str(FIXTURES / "gist" / "maya_action_needed.json"),
        ]
    )
    assert rc == 0
    out = json.loads(capsys.readouterr().out.split("\n", 1)[1])
    assert len(out["candidates"]) == 2
    assert {c["stance"] for c in out["candidates"]} == {"answer", "defer"}
    assert out["validator"]["passed"] is True


# ---------------------------------------------------------- the prompt cache split


def test_the_voice_pack_goes_in_the_cached_prefix_and_the_gist_in_the_suffix():
    """Nominal compliance is the failure mode: three arguments that get concatenated
    look identical from the outside and cost the whole saving."""
    rec = Recorder()
    draft(MAYA_PACK, MAYA_GIST, provider=rec, as_of="2026-08-01T00:00:00Z")
    system, cached_prefix, suffix = rec.calls[0]

    # Exemplars are static per (user, contact, voice_pack_version): cached side.
    for exemplar in MAYA_PACK["exemplars"]:
        assert exemplar in cached_prefix, exemplar
        assert exemplar not in suffix

    # The gist changes daily: uncached side.
    assert MAYA_GIST["gist"] in suffix
    assert MAYA_GIST["gist"] not in cached_prefix
    assert MAYA_GIST["gist_id"] in suffix

    assert system == SYSTEM
    assert cached_prefix and suffix


def test_the_cache_key_moves_with_the_voice_pack_and_not_with_the_gist():
    base = cache_key("usr_1", "h_8f21a4c0", "vp_4a91cc02")

    assert cache_key("usr_1", "h_8f21a4c0", "vp_4a91cc02") == base
    assert cache_key("usr_1", "h_8f21a4c0", "vp_ffffffff") != base, "new pack, new key"
    assert cache_key("usr_1", "h_00000000", "vp_4a91cc02") != base, "new contact, new key"
    assert cache_key("usr_2", "h_8f21a4c0", "vp_4a91cc02") != base, "new user, new key"


def _logged_cache_key(capsys, pack, gist) -> str:
    """The key the DRAFTER actually used, read back off its own log line."""
    draft(pack, gist, provider=Recorder(), as_of="2026-08-01T00:00:00Z")
    return json.loads(capsys.readouterr().out.strip().splitlines()[0])["cache_key"]


def test_the_cache_key_the_drafter_uses_is_not_a_function_of_the_gist(capsys):
    """Asserted against `draft()`, not against `cache_key()`.

    Testing the pure function only proves the helper is correct — it says nothing about
    what the drafter feeds it, and a drafter that quietly mixes the gist into the key
    passes every helper test while reusing the prefix exactly never. That is the
    nominal-compliance failure this criterion exists to catch, and an earlier version of
    this file missed it.
    """
    gist_a = dict(MAYA_GIST)
    gist_b = dict(MAYA_GIST, gist_id="g_deadbeef", gist="something else entirely")

    assert _logged_cache_key(capsys, MAYA_PACK, gist_a) == _logged_cache_key(
        capsys, MAYA_PACK, gist_b
    ), "the drafter's cache key moved when only the gist changed"


def test_the_cache_key_the_drafter_uses_moves_with_the_voice_pack(capsys):
    other_pack = dict(MAYA_PACK, voice_pack_version="vp_ffffffff")
    assert _logged_cache_key(capsys, MAYA_PACK, MAYA_GIST) != _logged_cache_key(
        capsys, other_pack, MAYA_GIST
    )


def test_the_cache_key_helper_is_pure_and_total():
    """Two different gists for the same contact and pack share a key. If they did not,
    the prefix would never be reused and the cache would be decoration."""
    base = cache_key("usr_1", MAYA_GIST["contact_id"], MAYA_PACK["voice_pack_version"])
    assert cache_key("usr_1", MAYA_GIST["contact_id"], MAYA_PACK["voice_pack_version"]) == base


def test_the_prompt_hash_covers_all_three_parts():
    base = prompt_hash("sys", "prefix", "suffix")
    assert base.startswith("ph_")
    assert prompt_hash("sys2", "prefix", "suffix") != base
    assert prompt_hash("sys", "prefix2", "suffix") != base
    assert prompt_hash("sys", "prefix", "suffix2") != base
    # Concatenation must not collide: ("ab","c") and ("a","bc") are different prompts.
    assert prompt_hash("s", "ab", "c") != prompt_hash("s", "a", "bc")


def test_the_allowlist_reaches_the_model():
    """`gist.v1.facts` is restated in the suffix so the model has less to invent and 04
    has less to reject."""
    suffix = render_gist(MAYA_GIST)
    for value in MAYA_GIST["facts"]["dates"]:
        assert value in suffix
    assert "ALLOWED SPECIFICS" in suffix


def test_a_gist_with_no_facts_says_so_explicitly():
    suffix = render_gist(YU_GIST)
    assert "none — do not name any specific" in suffix


def test_the_system_prompt_demands_stance_difference_and_owning_the_silence():
    assert "differ in STANCE" in SYSTEM
    assert "own the silence" in SYSTEM.lower() or "owning the silence" in SYSTEM.lower()


# ----------------------------------------------------------------------- logging


def test_the_log_line_carries_the_hash_and_not_the_prompt(capsys):
    """CONTRACTS.md § 6: log the prompt hash, never the prompt."""
    draft(MAYA_PACK, MAYA_GIST, provider=FakeProvider(), as_of="2026-08-01T00:00:00Z")
    logged = capsys.readouterr().out
    record = json.loads(logged.strip().splitlines()[0])

    assert record["event"] == "draft.produced"
    assert record["prompt_hash"].startswith("ph_")
    assert record["cache_key"].startswith("pc_")
    for field in ("voice_pack_version", "gist_id", "prompt_version", "model_id"):
        assert record[field], field

    # Nothing from the prompt, the corpus, or the output.
    for exemplar in MAYA_PACK["exemplars"]:
        assert exemplar not in logged
    assert MAYA_GIST["gist"] not in logged
    assert SYSTEM not in logged
    assert "ALLOWED SPECIFICS" not in logged


def test_the_log_never_carries_candidate_text(capsys):
    draft(MAYA_PACK, MAYA_GIST, provider=Recorder(), as_of="2026-08-01T00:00:00Z")
    logged = capsys.readouterr().out
    assert "yeah im in, lets do it" not in logged
    assert "can i lmk tmrw" not in logged


def test_the_bundle_is_reproducible_from_the_logged_identifiers(capsys):
    bundle = draft(MAYA_PACK, MAYA_GIST, provider=FakeProvider(), as_of="2026-08-01T00:00:00Z")
    record = json.loads(capsys.readouterr().out.strip().splitlines()[0])
    for field in ("voice_pack_version", "gist_id", "prompt_version", "model_id"):
        assert record[field] == getattr(bundle, field)


# ------------------------------------------------------------------------ router


def test_the_router_knows_exactly_three_providers():
    assert set(provider_names()) == {"fake", "gemini", "kimi"}


@pytest.mark.parametrize(
    "name,expected",
    [("fake", FakeProvider), ("gemini", GeminiProvider), ("kimi", KimiProvider)],
)
def test_the_router_selects_the_right_adapter(name, expected, monkeypatch):
    monkeypatch.setenv("BOI_MODEL_PROVIDER", name)
    assert isinstance(select_provider(), expected)
    assert isinstance(select_provider(name), expected)


def test_the_router_defaults_to_fake(monkeypatch):
    monkeypatch.delenv("BOI_MODEL_PROVIDER", raising=False)
    assert isinstance(select_provider(), FakeProvider)


def test_an_unknown_provider_raises_rather_than_falling_back(monkeypatch):
    """A typo that silently yields FakeProvider would make an eval run in 05 report
    recorded transcripts as live model output."""
    monkeypatch.setenv("BOI_MODEL_PROVIDER", "gemni")
    with pytest.raises(UnknownProvider):
        select_provider()


@pytest.mark.parametrize("provider_cls", [GeminiProvider, KimiProvider])
def test_live_adapters_refuse_without_the_allow_flag(provider_cls):
    p = provider_cls(api_key="pretend-key", allow_live=False)
    with pytest.raises(LiveCallsDisabled, match="BOI_ALLOW_LIVE_CALLS"):
        p.preflight()


@pytest.mark.parametrize("provider_cls", [GeminiProvider, KimiProvider])
def test_live_adapters_refuse_without_a_key(provider_cls):
    p = provider_cls(api_key="", allow_live=True)
    with pytest.raises(LiveCallsDisabled):
        p.preflight()


def test_constructing_a_live_adapter_makes_no_call():
    """Constructing must be free — 05 builds a whole matrix of them."""
    assert GeminiProvider(api_key="k", allow_live=False).model_id
    assert KimiProvider(api_key="k", allow_live=False).model_id


def test_the_suite_cannot_open_a_socket():
    """Proves the autouse guard in conftest is actually armed. Without this, "no
    network" is a claim rather than a property."""
    import socket

    with pytest.raises(NetworkUseInTests):
        socket.socket().connect(("192.0.2.1", 80))


# -------------------------------------------------------------- degraded outcomes


def test_one_candidate_degrades_to_zero():
    """The frozen dataclass raises on one candidate, so the drafter must never build
    such a bundle. Zero is legitimate; one is a contract violation."""
    scripted = Scripted(
        json.dumps({"candidates": [{"stance": "answer", "text": "only one"}]}),
        json.dumps({"candidates": [{"stance": "answer", "text": "still only one"}]}),
    )
    bundle = draft(MAYA_PACK, MAYA_GIST, provider=scripted, as_of="2026-08-01T00:00:00Z")
    assert bundle.candidates == []
    assert bundle.validator.passed is False
    assert "empty" in bundle.validator.failures


def test_two_candidates_sharing_a_stance_degrade_to_zero():
    same = json.dumps(
        {
            "candidates": [
                {"stance": "answer", "text": "yeah im in"},
                {"stance": "answer", "text": "yes im coming"},
            ]
        }
    )
    bundle = draft(
        MAYA_PACK, MAYA_GIST, provider=Scripted(same, same), as_of="2026-08-01T00:00:00Z"
    )
    assert bundle.candidates == []
    assert "stance_collision" in bundle.validator.failures


def test_the_drafter_retries_once_then_degrades():
    """`draft_bundle.v1` caps `validator.attempts` at 2."""
    bad = json.dumps({"candidates": [{"stance": "answer", "text": "one"}]})
    good = json.dumps(
        {
            "candidates": [
                {"stance": "answer", "text": "yeah im in"},
                {"stance": "defer", "text": "lmk tmrw"},
            ]
        }
    )
    recovered = Scripted(bad, good)
    bundle = draft(MAYA_PACK, MAYA_GIST, provider=recovered, as_of="2026-08-01T00:00:00Z")
    assert recovered.calls == 2
    assert bundle.validator.attempts == 2
    assert bundle.validator.passed is True
    assert len(bundle.candidates) == 2

    never = Scripted(bad, bad, bad)
    degraded = draft(MAYA_PACK, MAYA_GIST, provider=never, as_of="2026-08-01T00:00:00Z")
    assert never.calls == MAX_ATTEMPTS, "no more than one retry"
    assert degraded.validator.attempts <= 2
    assert degraded.candidates == []


def test_an_overlong_candidate_is_rejected():
    long_text = "x" * (MAX_CANDIDATE_CHARS + 1)
    payload = json.dumps(
        {
            "candidates": [
                {"stance": "answer", "text": long_text},
                {"stance": "defer", "text": "lmk tmrw"},
            ]
        }
    )
    bundle = draft(
        MAYA_PACK, MAYA_GIST, provider=Scripted(payload, payload), as_of="2026-08-01T00:00:00Z"
    )
    assert bundle.candidates == []
    assert "length_gate" in bundle.validator.failures


def test_every_failure_slug_is_in_the_frozen_vocabulary():
    for slugs in (
        structural_failures([]),
        structural_failures([{"stance": "answer", "text": ""}, {"stance": "defer", "text": "a"}]),
        structural_failures([{"stance": "answer", "text": "a"}, {"stance": "answer", "text": "b"}]),
        structural_failures(
            [
                {"stance": "answer", "text": "x" * 500},
                {"stance": "defer", "text": "b"},
            ]
        ),
    ):
        for slug in slugs:
            assert slug in VALIDATOR_FAILURES, slug


def test_the_validate_seam_is_called_and_can_reject():
    """Prompt 04 fills this seam. Proving it is wired now means 04 is a plug-in."""
    seen = {}

    def reject(candidates, gist, voice_pack):
        seen["candidates"] = candidates
        seen["gist_id"] = gist["gist_id"]
        return ["fabrication_gate"]

    bundle = draft(
        MAYA_PACK, MAYA_GIST, provider=FakeProvider(), as_of="2026-08-01T00:00:00Z", validate=reject
    )
    assert seen["gist_id"] == MAYA_GIST["gist_id"]
    assert len(seen["candidates"]) == 2
    assert bundle.candidates == []
    assert bundle.validator.failures == ["fabrication_gate"]


# ------------------------------------------------------------------------ parsing


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "not json at all",
        "{}",
        '{"candidates": "not a list"}',
        '{"candidates": [{"stance": "sideways", "text": "hi"}]}',
        '{"candidates": [{"stance": "answer"}]}',
    ],
)
def test_unusable_model_output_parses_to_nothing(raw):
    """Guessing at malformed output is how half a sentence reaches somebody's friend."""
    assert parse_candidates(raw) == []


def test_a_fenced_json_block_is_recovered():
    raw = (
        "Sure, here you go:\n```json\n"
        '{"candidates":[{"stance":"answer","text":"yeah"},'
        '{"stance":"defer","text":"lmk"}]}\n```'
    )
    got = parse_candidates(raw)
    assert [c["stance"] for c in got] == ["answer", "defer"]


def test_leading_chatter_is_tolerated():
    raw = 'Here: {"candidates":[{"stance":"answer","text":"yeah"},{"stance":"defer","text":"lmk"}]}'
    assert len(parse_candidates(raw)) == 2


# ------------------------------------------------------------------- rendering


def test_the_voice_pack_render_carries_register_and_exemplars():
    rendered = render_voice_pack(MAYA_PACK)
    assert str(MAYA_PACK["register"]["median_len_chars"]) in rendered
    assert MAYA_PACK["register"]["punctuation"] in rendered
    for exemplar in MAYA_PACK["exemplars"]:
        assert exemplar in rendered


def test_the_system_prompt_names_the_forbidden_phrases_it_can():
    """The validator in 04 is the enforcement; telling the model up front just means
    fewer rejections."""
    lowered = SYSTEM.lower()
    assert "circling back" in lowered
    assert any(p in lowered for p in FORBIDDEN_PHRASES if p.isascii() and len(p) > 4)
