"""The `understanding.open_thread` half of guard three, locked down.

WHY THIS FILE EXISTS. On 7 Aug a real inbound sentence was planted into
`understanding.open_thread`, `check_voice_pack_leak.py --digest` was run against the real
corpus, and the run was read as CLEAN. It was not: the guard fired and the violation count
went 825 -> 826. Two things downstream hid it -- the exit code was already 1 because
`relationship.facts` carries hundreds of standing violations on that corpus, and the
report printed only the first ten problems, all of which were facts.

So the guard was briefly believed to be dead when it was working. The tests below pin the
three properties that turn a firing check into a readable one, because "it fires" is not
the same claim as "a human can tell that it fired":

  1. it exits non-zero on a planted inbound sentence,
  2. it NAMES `understanding.open_thread` in the output, and
  3. it still names it when a noisier field has far more violations than the display cap.

(3) is the actual regression. (1) and (2) passed on the day; (3) is what made them
unreadable. A flat, truncated list brings the whole failure straight back.

Nothing here touches the user's real corpus: every fixture is synthetic and hermetic.
"""
from __future__ import annotations

import json
import pathlib
import sqlite3
import subprocess
import sys

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
CHECKER = REPO_ROOT / "scripts" / "check_voice_pack_leak.py"

# Over the 40-character cap on a fact token and over the 12-character span floor, so it is
# unambiguously prose rather than an allowlist token that happens to also be a message.
INBOUND_SENTENCE = "so are we still on for the apartment walkthrough on saturday morning"


def _mirror(path: pathlib.Path, inbound: list[str]) -> str:
    """A Boi mirror, minimally.

    `mirror_meta` is not decoration: `load_corpus` derives what the file IS from that
    table's presence and REFUSES a `--mirror` without it. A fixture missing it would make
    every test here pass for the wrong reason -- the script would exit non-zero before it
    ever looked at the digest.
    """
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE mirror_meta (key TEXT, value TEXT)")
    con.execute("CREATE TABLE message (guid TEXT, text TEXT, is_from_me INTEGER)")
    for index, text in enumerate(inbound):
        con.execute("INSERT INTO message VALUES (?, ?, 0)", (f"in-{index}", text))
    con.execute("INSERT INTO message VALUES ('out-0', 'ok sounds good', 1)")
    con.commit()
    con.close()
    return str(path)


def _digest(relationships: list[dict]) -> dict:
    return {"schema_version": "digest.v2", "relationships": relationships}


def _relationship(contact_id: str, *, open_thread=None, facts=None) -> dict:
    return {
        "contact_id": contact_id,
        "facts": facts or {},
        "understanding": {
            "register": "casual",
            "relationship_kind": "close_friend",
            "open_thread": open_thread,
            "last_exchange_shape": "question_from_them",
            "topics": [],
            "cadence_norm": "recently active",
            "voice_exemplars": [],
        },
    }


def _run(tmp_path: pathlib.Path, digest: dict, inbound: list[str]):
    digest_path = tmp_path / "digest_v2.json"
    digest_path.write_text(json.dumps(digest))
    mirror = _mirror(tmp_path / "mirror.db", inbound)
    proc = subprocess.run(
        [sys.executable, str(CHECKER), "--mirror", mirror, "--digest", str(digest_path)],
        capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def test_planted_inbound_sentence_in_open_thread_exits_non_zero(tmp_path):
    """The claim the 7 Aug run was supposed to test."""
    code, output = _run(
        tmp_path,
        _digest([_relationship("h_00000001", open_thread=INBOUND_SENTENCE)]),
        [INBOUND_SENTENCE],
    )
    assert code != 0, f"planted inbound prose did not fail the guard:\n{output}"


def test_violation_names_the_open_thread_field(tmp_path):
    """A non-zero exit that does not say WHICH guard bit is not actionable."""
    _, output = _run(
        tmp_path,
        _digest([_relationship("h_00000001", open_thread=INBOUND_SENTENCE)]),
        [INBOUND_SENTENCE],
    )
    assert "understanding.open_thread" in output, (
        f"the finding must name the field it was found in:\n{output}")


def test_open_thread_finding_survives_a_noisier_field(tmp_path):
    """THE REGRESSION. A quiet field must not be buried by a loud one.

    Forty `facts` violations against a ten-line display cap is precisely the shape of the
    real corpus, where 825 standing facts violations pushed the single open_thread finding
    to entry 826 and off the end of the report.
    """
    noisy = [
        _relationship(f"h_{index:08d}", facts={"places": [f"noisy place token {index}"]})
        for index in range(40)
    ]
    quiet = _relationship("h_ffffffff", open_thread=INBOUND_SENTENCE)

    code, output = _run(tmp_path, _digest(noisy + [quiet]), [INBOUND_SENTENCE])

    assert code != 0
    assert "understanding.open_thread" in output, (
        "a high-volume field crowded the open_thread finding out of the report -- this is "
        f"the exact failure that made the guard look dead:\n{output}")
    # Both fields must be named, so neither can hide behind the other's noise.
    assert "relationship.facts" in output


def test_clean_bare_template_passes(tmp_path):
    """The guard has to be quiet when there is nothing to say, or nobody will read it."""
    code, output = _run(
        tmp_path,
        _digest([_relationship("h_00000001", open_thread="unanswered question from them")]),
        [INBOUND_SENTENCE],
    )
    assert code == 0, f"a bare template is a legitimate value:\n{output}"


def test_allowlisted_topic_token_passes(tmp_path):
    """The Root 3 widening itself: a closed-vocabulary token in the documented slot."""
    code, output = _run(
        tmp_path,
        _digest([_relationship(
            "h_00000001",
            open_thread="asked more than once about the apartment, unanswered")]),
        [INBOUND_SENTENCE],
    )
    assert code == 0, f"an allowlisted topic token must pass:\n{output}"


@pytest.mark.parametrize("open_thread", [
    # A token outside the closed vocabulary -- either their words, or a Swift-side token
    # this script was not told about. Both are bugs.
    "asked more than once about the burrito, unanswered",
    # Their prose in the slot, under the 12-character span floor that protects ordinary
    # short words. This is the case the corpus checks alone cannot catch.
    "asked more than once about the walkthrough on saturday morning, unanswered",
    # The clause in a position the grammar does not define.
    "about the apartment, asked more than once, unanswered",
])
def test_open_thread_outside_the_closed_grammar_fails(tmp_path, open_thread):
    code, output = _run(
        tmp_path,
        _digest([_relationship("h_00000001", open_thread=open_thread)]),
        [INBOUND_SENTENCE],
    )
    assert code != 0, f"{open_thread!r} is outside the closed grammar:\n{output}"
    assert "understanding.open_thread" in output
