"""Foundation harness test. Track B extends the suite; it never weakens this file."""
import json
import pathlib

import pytest

from boi_intel.contracts import Candidate, DraftBundle, GistFacts, ValidatorResult

ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_fixtures_exist():
    assert (ROOT / "contracts" / "fixtures" / "voice_pack" / "maya.json").exists()


def test_bundle_rejects_one_candidate():
    with pytest.raises(ValueError):
        DraftBundle(
            schema_version="draft_bundle.v1", contact_id="h_1", gist_id="g_1",
            candidates=[Candidate("answer", "hi", 2)],
            model_id="fake", prompt_version="draft.v1", voice_pack_version="vp_1",
            validator=ValidatorResult(True, 1, []), as_of="2026-08-01T00:00:00Z",
        )


def test_bundle_rejects_two_of_the_same_stance():
    with pytest.raises(ValueError):
        DraftBundle(
            schema_version="draft_bundle.v1", contact_id="h_1", gist_id="g_1",
            candidates=[Candidate("answer", "a", 1), Candidate("answer", "b", 1)],
            model_id="fake", prompt_version="draft.v1", voice_pack_version="vp_1",
            validator=ValidatorResult(True, 1, []), as_of="2026-08-01T00:00:00Z",
        )


def test_zero_candidates_is_legitimate():
    b = DraftBundle(
        schema_version="draft_bundle.v1", contact_id="h_1", gist_id="g_1",
        candidates=[], model_id="fake", prompt_version="draft.v1",
        voice_pack_version="vp_1",
        validator=ValidatorResult(False, 2, ["forbidden_phrase"]),
        as_of="2026-08-01T00:00:00Z",
    )
    assert b.candidates == []


def test_gist_facts_allowlist_round_trips():
    f = GistFacts(dates=["the 14th"], times=[], places=[], amounts=[], names=[])
    assert "the 14th" in f.all_values()


def test_maya_fixture_matches_the_dataclass_shape():
    raw = json.loads((ROOT / "contracts" / "fixtures" / "voice_pack" / "maya.json").read_text())
    assert raw["scope"] == "contact"
    assert raw["n_exemplars"] == len(raw["exemplars"])
