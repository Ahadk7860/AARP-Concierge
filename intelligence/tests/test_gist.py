"""Gist production.

The no-verbatim test is the one that matters here, the way the inbound-canary test is
the one that matters in `test_voice_pack.py`. The gist crosses the boundary to the
cloud; if the other person's sentences can ride along inside it, the digest boundary is
decorative. Do not weaken it to make a run green.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
from datetime import UTC, datetime, timedelta

import pytest
from boi_intel import chatdb
from boi_intel import gist as gist_mod
from boi_intel.gist import (
    DEADLINE_MAX_DAYS_SILENT,
    MAX_GIST_CHARS,
    MODEL_ENV_VAR,
    LocalModelGistProducer,
    ModelUnavailable,
    SqlGistProducer,
    build_gists,
    classify,
    main,
    priority,
    select_producer,
    write_gists,
)
from boi_intel.threads import ThreadStats, load_threads
from conftest import make_db, received, sent

ROOT = pathlib.Path(__file__).resolve().parents[2]
SALT = b"test-salt"
AS_OF = "2026-08-01T00:00:00Z"

INBOUND_CANARY = "zzq the plumber is coming thursday and i left the spare key under the blue pot"


def _now() -> int:
    return int(datetime(2026, 8, 1, tzinfo=UTC).timestamp())


def _ago(days: int, hours: int = 0) -> datetime:
    return datetime(2026, 8, 1, tzinfo=UTC) - timedelta(days=days, hours=hours)


def _thread(tmp_path, messages, last_message_days_ago: int, name: str = "chat.db"):
    """Build a thread whose final message lands `last_message_days_ago` before `_now()`."""
    start = _ago(last_message_days_ago + len(messages) - 1)
    return make_db(tmp_path / name, messages, start=start, spacing_hours=24)


# ------------------------------------------------------------ the no-verbatim anchor


def test_the_gist_never_quotes_the_other_person(tmp_path):
    db = _thread(
        tmp_path,
        [
            sent("ok that works for me"),
            received(INBOUND_CANARY),
        ],
        last_message_days_ago=6,
    )

    gists = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())
    assert gists, "expected a gist for a thread with an unanswered inbound message"

    for g in gists:
        blob = json.dumps(g, ensure_ascii=False)
        assert INBOUND_CANARY not in blob
        # and no substantial run of it either
        for fragment in (
            "the plumber is coming",
            "spare key",
            "under the blue pot",
            "left the spare",
        ):
            assert fragment not in blob, f"{fragment!r} leaked into {blob}"


def test_no_generated_gist_contains_a_six_word_run_from_the_thread(tmp_path):
    """Stronger than a substring check: any six consecutive words shared with an
    inbound message would be a quotation."""
    inbound = [
        "are you still coming on the 14th of next month or not",
        "we really need to book the flights by friday afternoon at the latest",
    ]
    db = _thread(tmp_path, [sent("ok")] + [received(t) for t in inbound], last_message_days_ago=5)
    gists = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())
    assert gists

    for g in gists:
        words = g["gist"].lower().split()
        runs = {" ".join(words[i : i + 6]) for i in range(max(0, len(words) - 5))}
        for source in inbound:
            flat = " ".join(source.lower().split())
            assert not any(r in flat for r in runs), g["gist"]


def test_the_raw_handle_never_appears_in_a_gist(tmp_path):
    """CONTRACTS.md section 3: the server never sees a raw handle for anyone but the
    account holder. `display` is omitted for exactly this reason — see NOTES.md."""
    handle = "+15550100999"
    db = _thread(tmp_path, [sent("ok"), received("are you around")], last_message_days_ago=4)
    gists = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())
    assert gists
    for g in gists:
        blob = json.dumps(g)
        assert handle not in blob
        assert "5550100999" not in blob
        assert g["contact_id"].startswith("h_")


# ---------------------------------------------------------------------- the CLI


def test_cli_writes_valid_gist_files(tmp_path, monkeypatch):
    monkeypatch.setenv("BOI_DEV_USER_SALT", "test-salt")
    db = _thread(
        tmp_path,
        [
            sent("ok that works"),
            received("are you still coming on the 14th"),
        ],
        last_message_days_ago=5,
    )
    out = tmp_path / "gists"

    assert main(["--db", str(db), "--out", str(out), "--top", "5"]) == 0
    files = sorted(out.glob("*.json"))
    assert files

    for path in files:
        r = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "validate_fixtures.py"), "gist.v1", str(path)],
            capture_output=True,
            text=True,
        )
        assert r.returncode == 0, r.stdout + r.stderr


def test_top_limits_the_output(tmp_path):
    db = _thread(tmp_path, [sent("hi"), received("you around")], last_message_days_ago=5)
    all_gists = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())
    limited = build_gists(str(db), top=1, salt=SALT, as_of=AS_OF, now_epoch=_now())
    assert len(limited) <= 1
    assert len(limited) <= len(all_gists)


# ---------------------------------------------------------------- gist string


def test_every_gist_string_is_within_the_cap(tmp_path):
    db = _thread(
        tmp_path,
        [
            sent("ok"),
            received("are you still coming on the 14th and can we book friday"),
        ],
        last_message_days_ago=5,
    )
    for g in build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now()):
        assert len(g["gist"]) <= MAX_GIST_CHARS, g["gist"]


def test_generated_fixture_gists_are_all_within_the_cap():
    """Over the committed fixtures too, so the cap is not only tested on our own data."""
    for path in (ROOT / "contracts" / "fixtures" / "gist").glob("*.json"):
        assert len(json.loads(path.read_text())["gist"]) <= MAX_GIST_CHARS


@pytest.mark.parametrize("state", ["action_needed", "fading", "dormant", "revived"])
def test_every_state_has_a_template(state):
    stats = ThreadStats(
        handle="+1",
        days_silent=30,
        total_messages=100,
        max_gap_days=120,
        median_reply_latency_seconds=900,
    )
    text = gist_mod.sql_gist_text(
        stats, state, {"dates": [], "times": [], "places": [], "amounts": [], "names": []}
    )
    assert text and len(text) <= MAX_GIST_CHARS


def test_the_gist_string_is_an_invitation_not_a_verdict():
    """CONTRACTS.md section 6. "they don't text you back" is a judgement about a person
    and never ships."""
    stats = ThreadStats(handle="+1", days_silent=40, total_messages=200)
    for state in ("action_needed", "fading", "dormant"):
        text = gist_mod.sql_gist_text(
            stats, state, {"dates": [], "times": [], "places": [], "amounts": [], "names": []}
        ).lower()
        for forbidden in (
            "doesn't",
            "does not text",
            "ignoring you",
            "ghosted",
            "you should",
            "you failed",
        ):
            assert forbidden not in text, text


# ------------------------------------------------------------------ classification


@pytest.mark.parametrize(
    "days,last_from_me,expected",
    [
        (0, True, None),  # healthy, nothing owed
        (1, True, None),
        (3, False, "action_needed"),
        (12, False, "action_needed"),
        (30, True, "fading"),
        (200, True, "dormant"),
        (400, False, "dormant"),
    ],
)
def test_classification_table(days, last_from_me, expected):
    stats = ThreadStats(
        handle="+1", days_silent=days, last_from_me=last_from_me, total_messages=100
    )
    assert classify(stats) == expected


def test_a_healthy_thread_gets_no_gist(tmp_path):
    """The load-bearing `None`: forcing every thread into a state would put people who
    are perfectly fine into the morning brief."""
    db = _thread(
        tmp_path, [received("hey how are you"), sent("good! you?")], last_message_days_ago=0
    )
    assert build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now()) == []


def test_birthday_is_never_invented():
    """It needs a birth date from Contacts.app, which Track B cannot see. Guessing one
    from message text is fabrication — see NOTES.md."""
    for days in (0, 1, 5, 30, 200, 500):
        for last_from_me in (True, False):
            stats = ThreadStats(
                handle="+1", days_silent=days, last_from_me=last_from_me, total_messages=50
            )
            assert classify(stats) != "birthday"


def test_revived_requires_a_long_prior_gap():
    recent = ThreadStats(
        handle="+1", days_silent=3, last_from_me=True, total_messages=100, max_gap_days=120
    )
    assert classify(recent) == "revived"
    no_gap = ThreadStats(
        handle="+1", days_silent=3, last_from_me=True, total_messages=100, max_gap_days=2
    )
    assert classify(no_gap) is None


# --------------------------------------------------------------------- priority


def test_priority_is_within_range_and_stable():
    stats = ThreadStats(
        handle="+1",
        days_silent=5,
        last_from_me=False,
        unanswered_question=True,
        total_messages=1200,
    )
    first = priority(stats, "action_needed")
    assert 0.0 <= first <= 1.0
    for _ in range(5):
        assert priority(stats, "action_needed") == first


def test_someone_waiting_outranks_someone_who_is_not(tmp_path):
    waiting = ThreadStats(
        handle="+1", days_silent=5, last_from_me=False, unanswered_question=True, total_messages=500
    )
    quiet = ThreadStats(handle="+2", days_silent=5, last_from_me=True, total_messages=500)
    assert priority(waiting, "action_needed") > priority(quiet, "fading")


def test_ranking_is_stable_across_runs(tmp_path):
    """Same input, same order — including the tie-break, which is `contact_id`."""
    db = tmp_path / "chat.db"
    _multi_thread_db(db)
    runs = [
        [g["contact_id"] for g in build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())]
        for _ in range(4)
    ]
    assert all(r == runs[0] for r in runs)
    assert len(runs[0]) >= 2, "need at least two gists for ordering to mean anything"


def test_ranking_is_descending_by_priority(tmp_path):
    db = tmp_path / "chat.db"
    _multi_thread_db(db)
    gists = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())
    priorities = [g["priority"] for g in gists]
    assert priorities == sorted(priorities, reverse=True)


def _multi_thread_db(path: pathlib.Path) -> None:
    """Three one-to-one threads in one database, in different states."""
    import sqlite3

    from conftest import SCHEMA, to_apple_ns

    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    cur = con.cursor()
    spec = [("+15550100011", 4, 0), ("+15550100012", 40, 1), ("+15550100013", 250, 0)]
    for handle, quiet_days, last_from_me in spec:
        cur.execute(
            "INSERT INTO handle (id, service, country) VALUES (?,?,?)", (handle, "iMessage", "us")
        )
        hid = cur.lastrowid
        cur.execute(
            "INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?,?,?,?)",
            (f"iMessage;-;{handle}", 45, handle, "iMessage"),
        )
        cid = cur.lastrowid
        cur.execute("INSERT INTO chat_handle_join VALUES (?,?)", (cid, hid))
        for i in range(12):
            when = _ago(quiet_days + (11 - i))
            from_me = last_from_me if i == 11 else (i % 2)
            cur.execute(
                """INSERT INTO message (guid, text, handle_id, service, date, is_from_me)
                   VALUES (?,?,?,?,?,?)""",
                (
                    f"{handle}-{i}",
                    "are you around" if not from_me else "ok sounds good",
                    0 if from_me else hid,
                    "iMessage",
                    to_apple_ns(when),
                    from_me,
                ),
            )
            cur.execute(
                "INSERT INTO chat_message_join VALUES (?,?,?)",
                (cid, cur.lastrowid, to_apple_ns(when)),
            )
    con.commit()
    con.close()


# ------------------------------------------------------------------- deadlines


def test_a_stale_date_is_not_a_deadline(tmp_path):
    """A date mentioned 300 days ago is not something you owe an answer on. Promoting
    it to `has_deadline` is a fabricated commitment in the user's own name."""
    db = _thread(
        tmp_path,
        [
            sent("ok"),
            received("are you still coming on the 14th"),
        ],
        last_message_days_ago=300,
    )
    gists = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())
    assert gists
    for g in gists:
        assert g["has_deadline"] is False
        assert g["deadline_hint"] is None


def test_a_recent_date_is_a_deadline(tmp_path):
    db = _thread(
        tmp_path,
        [
            sent("ok"),
            received("are you still coming on the 14th"),
        ],
        last_message_days_ago=5,
    )
    gists = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())
    assert gists
    g = gists[0]
    assert g["has_deadline"] is True
    assert g["deadline_hint"] == "the 14th"
    assert DEADLINE_MAX_DAYS_SILENT >= 5


# -------------------------------------------------------------------- producers


def test_producer_is_sql_when_the_model_env_var_is_empty(monkeypatch):
    monkeypatch.setenv(MODEL_ENV_VAR, "")
    producer, reason = select_producer()
    assert isinstance(producer, SqlGistProducer)
    assert producer.producer == "sql"
    assert reason is None


def test_the_whole_path_runs_with_no_model_present(tmp_path, monkeypatch):
    """No MLX, no llama.cpp, no weights on disk — the shipped configuration for an
    Intel Mac, and the permanent fallback per CONTRACTS.md section 11 item 11."""
    monkeypatch.setenv(MODEL_ENV_VAR, "")
    db = _thread(tmp_path, [sent("ok"), received("you around")], last_message_days_ago=5)
    gists = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())
    assert gists
    for g in gists:
        assert g["producer"] == "sql"
        assert g["model_id"] is None


def test_a_configured_but_missing_model_degrades_instead_of_raising(monkeypatch):
    """Degrade, never fabricate — and never crash the morning brief either."""
    monkeypatch.setenv(MODEL_ENV_VAR, "some-org/some-4b-model")
    producer, reason = select_producer()
    assert isinstance(producer, SqlGistProducer)
    assert reason, "a degraded producer must say why"


def test_build_gists_degrades_when_the_producer_raises(tmp_path):
    class Exploding:
        producer = "local_model"
        model_id = "boom"

        def available(self) -> bool:
            return True

        def produce(self, *a, **k):
            raise ModelUnavailable("weights vanished mid-run")

    db = _thread(tmp_path, [sent("ok"), received("you around")], last_message_days_ago=5)
    gists = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now(), producer=Exploding())
    assert gists
    assert all(g["producer"] == "sql" for g in gists)


def test_the_local_producer_reports_why_it_is_unavailable():
    p = LocalModelGistProducer(model_id="some-org/some-4b-model")
    assert p.available() is False
    assert "weights not downloaded" in p.unavailable_reason()


def test_download_raises_model_unavailable_not_a_transport_error():
    p = LocalModelGistProducer(model_id="some-org/definitely-not-a-real-model")
    with pytest.raises(ModelUnavailable):
        p.download()


def test_a_model_that_quotes_the_corpus_has_its_output_discarded():
    """Plumbing only — a stub backend, not model output. The point is the guard: a
    local model that copies the other person's sentence must not get that sentence into
    a document crossing the boundary."""
    quoted = "are you still coming on the 14th of next month"

    class Copycat:
        def summarize(self, inbound, state, facts):
            return quoted

    stats = ThreadStats(
        handle="+1",
        days_silent=5,
        last_from_me=False,
        unanswered_question=True,
        total_messages=50,
        recent_inbound_text=[quoted],
    )
    p = LocalModelGistProducer(model_id="stub", backend=Copycat())
    out = p.produce("h_0123456789ab", stats, "action_needed", AS_OF)

    assert quoted not in out["gist"]
    assert out["producer"] == "sql", "a discarded model answer must not claim to be one"


def test_an_overlong_model_answer_is_discarded():
    class Rambler:
        def summarize(self, inbound, state, facts):
            return "x" * (MAX_GIST_CHARS + 1)

    stats = ThreadStats(
        handle="+1",
        days_silent=5,
        last_from_me=False,
        total_messages=50,
        recent_inbound_text=["you around"],
    )
    out = LocalModelGistProducer(model_id="stub", backend=Rambler()).produce(
        "h_0123456789ab", stats, "action_needed", AS_OF
    )
    assert len(out["gist"]) <= MAX_GIST_CHARS
    assert out["producer"] == "sql"


def test_a_usable_model_answer_is_kept_and_labelled():
    class Terse:
        def summarize(self, inbound, state, facts):
            return "they need an answer from you about the trip"

    stats = ThreadStats(
        handle="+1",
        days_silent=5,
        last_from_me=False,
        total_messages=50,
        recent_inbound_text=["you around"],
    )
    out = LocalModelGistProducer(model_id="stub-4b", backend=Terse()).produce(
        "h_0123456789ab", stats, "action_needed", AS_OF
    )
    assert out["gist"] == "they need an answer from you about the trip"
    assert out["producer"] == "local_model"
    assert out["model_id"] == "stub-4b"


def test_the_model_cannot_move_structured_fields():
    """The model rewrites the sentence and nothing else. A confused model must not be
    able to invent a deadline or push someone up the brief."""

    class Liar:
        def summarize(self, inbound, state, facts):
            return "totally urgent, respond immediately"

    stats = ThreadStats(
        handle="+1",
        days_silent=9,
        last_from_me=False,
        total_messages=50,
        recent_inbound_text=["you around"],
    )
    sql = SqlGistProducer().produce("h_0123456789ab", stats, "action_needed", AS_OF)
    model = LocalModelGistProducer(model_id="stub", backend=Liar()).produce(
        "h_0123456789ab", stats, "action_needed", AS_OF
    )

    for field in (
        "state",
        "days_silent",
        "unanswered_question",
        "has_deadline",
        "deadline_hint",
        "facts",
        "priority",
        "contact_id",
    ):
        assert model[field] == sql[field], field


# ----------------------------------------------------------------------- misc


def test_gists_are_deterministic(tmp_path):
    db = _thread(tmp_path, [sent("ok"), received("you around")], last_message_days_ago=5)
    a = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())
    b = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())
    assert a == b


def test_write_gists_round_trips(tmp_path):
    db = _thread(tmp_path, [sent("ok"), received("you around")], last_message_days_ago=5)
    gists = build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now())
    written = write_gists(gists, str(tmp_path / "out"))
    assert len(written) == len(gists)
    for path, g in zip(written, gists, strict=True):
        assert json.loads(path.read_text()) == g


def test_group_chats_do_not_produce_gists(tmp_path):
    """A group thread cannot be attributed to one person."""
    import sqlite3

    from conftest import SCHEMA, to_apple_ns

    db = tmp_path / "chat.db"
    con = sqlite3.connect(db)
    con.executescript(SCHEMA)
    cur = con.cursor()
    cur.execute(
        "INSERT INTO handle (id, service, country) VALUES (?,?,?)",
        ("+15550100777", "iMessage", "us"),
    )
    hid = cur.lastrowid
    cur.execute(
        "INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?,?,?,?)",
        ("iMessage;+;chat777", 43, "chat777", "iMessage"),
    )
    cid = cur.lastrowid
    cur.execute("INSERT INTO chat_handle_join VALUES (?,?)", (cid, hid))
    for i in range(6):
        when = _ago(30 + i)
        cur.execute(
            """INSERT INTO message (guid, text, handle_id, service, date, is_from_me)
               VALUES (?,?,?,?,?,?)""",
            (f"G-{i}", "you around", hid, "iMessage", to_apple_ns(when), 0),
        )
        cur.execute(
            "INSERT INTO chat_message_join VALUES (?,?,?)", (cid, cur.lastrowid, to_apple_ns(when))
        )
    con.commit()
    con.close()

    assert build_gists(str(db), salt=SALT, as_of=AS_OF, now_epoch=_now()) == []


def test_null_text_rows_still_count_for_timing(tmp_path):
    """~47% of a real corpus has NULL text. Ignoring those rows for timing reports a
    live thread as quiet — a confident wrong answer about somebody's friend."""
    db = _thread(
        tmp_path,
        [
            sent("ok that works"),
            received("you around"),
        ],
        last_message_days_ago=200,
    )

    import sqlite3

    from conftest import to_apple_ns

    con = sqlite3.connect(db)
    con.execute(
        """INSERT INTO message (guid, text, handle_id, service, date, is_from_me)
           VALUES (?,?,?,?,?,?)""",
        ("NULLROW", None, 1, "iMessage", to_apple_ns(_ago(2)), 0),
    )
    con.execute(
        "INSERT INTO chat_message_join VALUES (?,?,?)",
        (1, con.execute("SELECT MAX(ROWID) FROM message").fetchone()[0], to_apple_ns(_ago(2))),
    )
    con.commit()
    con.close()

    con = chatdb.connect(str(db))
    stats = load_threads(con, now_epoch=_now())
    con.close()
    assert stats["+15550100999"].days_silent == 2, "a NULL-text row must count for timing"


# ------------------------------------------------- prompt 06: the vacuous fabrication gate
#
# AMENDMENT-001 made gist production digest-driven, and that path sets
# `recent_inbound_text=[]` ALWAYS -- correctly, because the digest carries metadata and
# never prose. The guard on a model-written gist is a length check plus
# `_quotes_the_corpus`, and that function iterated the corpus looking for overlap, so with
# nothing to iterate it answered "does not quote" for every input on earth.
#
# Any hallucination under 140 characters was therefore accepted, became `gist["gist"]`,
# was handed to the drafter as `situation:`, and was shown to the user as the brief item
# body. Latent only because no MLX backend is installed -- which is precisely why testing
# would never have found it.


def test_quotes_the_corpus_fails_CLOSED_on_an_empty_corpus():
    # The question is not "did it quote?" but "can I show this to somebody?", and with no
    # corpus to check against the answer is no.
    assert gist_mod._quotes_the_corpus("a sentence nobody ever said", []) is True
    # And it still answers the original question when there IS a corpus.
    assert gist_mod._quotes_the_corpus("a sentence nobody ever said", ["something else"]) is False
    said = "are you still coming on the 14th of the month"
    assert gist_mod._quotes_the_corpus(said, [said]) is True


class _HallucinatingProducer:
    """A model producer that returns a plausible sentence from nothing at all."""

    producer = "local_model"
    model_id = "fake-local-model"

    def produce(self, contact_id, stats, state, as_of):  # noqa: D102, ANN001
        base = gist_mod.SqlGistProducer().produce(contact_id, stats, state, as_of)
        base["gist"] = "they are waiting to hear about the deposit before friday"
        base["producer"] = self.producer
        base["model_id"] = self.model_id
        return base


def _digest_with_one_relationship() -> dict:
    return {
        "schema_version": "digest.v1",
        "generated_at": "2026-08-08T12:00:00Z",
        "relationships": [
            {
                "contact_id": "h_00000000000000ab",
                "display": "Ade Oyelaran",
                "is_group": False,
                "message_count": 400,
                "days_since_last_contact": 50,
                "momentum_90d": 0.3,
                "initiation_ratio": 0.6,
                "last_from_me": False,
                "max_gap_days": 60,
                "unanswered_question": True,
                "facts": {"dates": [], "times": [], "places": [], "amounts": [], "names": []},
            }
        ],
    }


def test_the_digest_path_REFUSES_a_model_producer():
    # Refuses rather than degrades. `ModelUnavailable` means "no backend, use SQL" and is
    # caught per thread; this means "you asked for something that cannot be correct", and
    # quietly degrading it is how the hole above survived.
    with pytest.raises(gist_mod.ModelProducerNotAvailableOnDigestPath):
        gist_mod.gists_from_digest(
            _digest_with_one_relationship(), producer=_HallucinatingProducer()
        )


def test_the_digest_path_still_produces_with_the_sql_producer():
    # The counter-case: the refusal is about the producer, not about the path being
    # broken.
    gists = gist_mod.gists_from_digest(_digest_with_one_relationship())
    assert len(gists) == 1
    assert gists[0]["producer"] == "sql"
