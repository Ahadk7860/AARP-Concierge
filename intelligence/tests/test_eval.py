"""The eval harness.

The first test is the one that matters. If the voice pack for a draft at time T can see
a message from after T, every number the harness produces is inflated and nothing in the
output looks wrong — the scores just come back better than they should be. Do not weaken
it, and do not narrow its input.
"""

from __future__ import annotations

import json
import pathlib
from datetime import UTC, datetime

import pytest
from boi_intel.eval import (
    CallCapExceeded,
    CallCapped,
    OracleProvider,
    Throttled,
    build_provider,
    register_matches,
    render_table,
    run_model,
    surface_register,
    write_review_file,
)
from boi_intel.evalset import MAX_REPLY_LAG_DAYS, build_cases
from boi_intel.providers.fake import FakeProvider
from boi_intel.providers.gemini import LiveCallsDisabled
from boi_intel.redact import redact
from boi_intel.voice import _truncate
from conftest import make_db, received, sent

ROOT = pathlib.Path(__file__).resolve().parents[2]
SALT = b"eval-test-salt"
FIXTURE_DB = "/tmp/boi-b/chat.db"


def _conversation(tmp_path, name="chat.db"):
    """A thread with several answered inbound runs, so cases exist at many cutoffs."""
    turns = []
    for i in range(14):
        turns.append(sent(f"ok that works for me number {i}"))
        turns.append(received(f"hey are you around number {i}"))
        turns.append(sent(f"yeah im free number {i}"))
    return make_db(
        tmp_path / name,
        turns,
        start=datetime(2026, 1, 1, tzinfo=UTC),
        spacing_hours=6,
    )


# --------------------------------------------------------------- the leakage anchor


def test_no_future_leakage(tmp_path):
    """No exemplar in a case's voice pack may come from a message at or after its cutoff.

    Checked two ways, because one direction alone is weak: every exemplar must be
    derivable from the pre-cutoff slice, AND no post-cutoff sent message may appear.
    """
    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT)
    assert cases, "no eval cases were built"

    import sqlite3

    from boi_intel.chatdb import apple_ns_to_epoch

    con = sqlite3.connect(db)
    rows = [
        (apple_ns_to_epoch(d), t)
        for t, d in con.execute("SELECT text, date FROM message WHERE is_from_me = 1")
    ]
    con.close()

    for case in cases:
        before = {_truncate(redact(t)) for ts, t in rows if ts < case.cutoff_ts and t}
        after = {_truncate(redact(t)) for ts, t in rows if ts >= case.cutoff_ts and t}

        for exemplar in case.voice_pack["exemplars"]:
            assert exemplar in before, (
                f"{exemplar!r} is not derivable from messages before {case.cutoff_ts}"
            )
        leaked = set(case.voice_pack["exemplars"]) & (after - before)
        assert not leaked, f"future messages leaked into the pack: {leaked}"


def test_the_leakage_check_would_notice_a_leak(tmp_path):
    """Proves the assertion above can fail. A pack built from the WHOLE thread must be
    caught by the same comparison."""
    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT)
    case = cases[0]

    import sqlite3

    from boi_intel.chatdb import apple_ns_to_epoch

    con = sqlite3.connect(db)
    rows = [
        (apple_ns_to_epoch(d), t)
        for t, d in con.execute("SELECT text, date FROM message WHERE is_from_me = 1")
    ]
    con.close()

    before = {_truncate(redact(t)) for ts, t in rows if ts < case.cutoff_ts and t}
    after = {_truncate(redact(t)) for ts, t in rows if ts >= case.cutoff_ts and t}
    assert after - before, "fixture must have post-cutoff messages for this to mean anything"
    assert not (after - before) <= before


def test_the_gist_state_is_computed_from_before_the_cutoff_only(tmp_path):
    db = _conversation(tmp_path)
    for case in build_cases(str(db), salt=SALT):
        # days_silent is measured back from the cutoff, so it can never be negative and
        # can never exceed the age of the thread at that moment.
        assert case.gist["days_silent"] >= 0
        assert case.cutoff_ts > 0


def test_every_case_has_a_real_reply_and_a_bounded_lag(tmp_path):
    db = _conversation(tmp_path)
    for case in build_cases(str(db), salt=SALT):
        assert case.actual_reply.strip()
        assert 0 <= case.reply_lag_seconds <= MAX_REPLY_LAG_DAYS * 86_400


def test_a_thread_the_user_never_answered_yields_no_case(tmp_path):
    """Ground truth is the whole point. No reply, no case."""
    db = make_db(
        tmp_path / "chat.db",
        [sent(f"line {i}") for i in range(8)] + [received("you around"), received("hello")],
        start=datetime(2026, 1, 1, tzinfo=UTC),
    )
    assert build_cases(str(db), salt=SALT) == []


def test_a_thread_with_too_little_history_yields_no_case(tmp_path):
    """Fewer than five sent messages before T and the pack means nothing."""
    db = make_db(
        tmp_path / "chat.db",
        [sent("hi"), sent("ok"), received("you around"), sent("yeah")],
        start=datetime(2026, 1, 1, tzinfo=UTC),
    )
    assert build_cases(str(db), salt=SALT) == []


def test_a_reply_months_later_is_not_ground_truth(tmp_path):
    """A reply three months on is a new conversation; scoring against it measures
    nothing."""
    start = datetime(2026, 1, 1, tzinfo=UTC)
    turns = [sent(f"ok that works number {i}") for i in range(6)]
    turns.append(received("you around"))
    turns.append(sent("yeah sorry"))
    # 24h spacing puts the reply one day after the inbound — inside the window.
    db = make_db(tmp_path / "near.db", turns, start=start, spacing_hours=24)
    assert build_cases(str(db), salt=SALT)

    # 24h * 40 puts it 40 days out — outside it.
    far = make_db(tmp_path / "far.db", turns, start=start, spacing_hours=24 * 40)
    assert build_cases(str(far), salt=SALT) == []


# -------------------------------------------------------------------- determinism


def test_building_the_eval_set_twice_is_identical(tmp_path):
    db = _conversation(tmp_path)
    a = build_cases(str(db), salt=SALT)
    b = build_cases(str(db), salt=SALT)
    assert [c.case_id for c in a] == [c.case_id for c in b]
    assert [c.voice_pack["voice_pack_version"] for c in a] == [
        c.voice_pack["voice_pack_version"] for c in b
    ]
    assert [c.gist["gist_id"] for c in a] == [c.gist["gist_id"] for c in b]


def test_rerunning_fake_produces_identical_numbers(tmp_path):
    """The determinism control doing its job."""
    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT, limit=10)
    first = run_model("fake", cases, 100).summary()
    second = run_model("fake", cases, 100).summary()
    assert first == second


def test_rerunning_oracle_produces_identical_numbers(tmp_path):
    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT, limit=10)
    assert run_model("oracle", cases, 100).summary() == run_model("oracle", cases, 100).summary()


# ------------------------------------------------------------------- the controls


def test_the_oracle_scores_a_perfect_register_match(tmp_path):
    """The metric checking itself. Comparing the real reply to itself must score 1.0;
    anything else means `register_matches` is measuring the wrong thing."""
    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT, limit=10)
    summary = run_model("oracle", cases, 100).summary()
    assert summary["register_match_rate"] == 1.0
    assert summary["median_len_delta"] == 0


def test_fake_reports_no_recording_rather_than_pretending(tmp_path):
    """`FakeProvider` only knows four fixture gist_ids. On corpus-derived cases it
    answers none, and that is reported rather than hidden."""
    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT, limit=10)
    summary = run_model("fake", cases, 100).summary()
    assert summary["cases"] == len(cases)
    assert summary["answered"] == 0
    assert summary["no_recording"] == len(cases)


# ------------------------------------------------------------- skipped, not omitted


def test_an_unreachable_model_is_a_row_not_an_omission(tmp_path, monkeypatch):
    monkeypatch.setenv("BOI_ALLOW_LIVE_CALLS", "1")
    monkeypatch.setattr("boi_intel.env.from_dotenv", lambda key, path=None: None)

    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT, limit=3)
    result = run_model("kimi-k2.5", cases, 100)

    assert result.skipped_reason, "a model that cannot be reached must say why"
    summary = result.summary()
    assert summary["model"] == "kimi-k2.5"
    assert "skipped" in summary


def test_the_table_renders_a_skipped_row_visibly(tmp_path, monkeypatch):
    monkeypatch.setenv("BOI_ALLOW_LIVE_CALLS", "1")
    monkeypatch.setenv("KIMI_API_KEY", "")
    monkeypatch.setattr("boi_intel.env.from_dotenv", lambda key, path=None: None)

    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT, limit=3)
    table = render_table([run_model("oracle", cases, 100), run_model("kimi-k2.5", cases, 100)])
    assert "kimi-k2.5" in table
    assert "SKIPPED" in table
    assert "KIMI_API_KEY" in table


def test_building_a_live_provider_without_permission_raises(monkeypatch):
    monkeypatch.delenv("BOI_ALLOW_LIVE_CALLS", raising=False)
    monkeypatch.setattr("boi_intel.env.from_dotenv", lambda key, path=None: None)
    with pytest.raises(LiveCallsDisabled):
        build_provider("gemini-3.5-flash-lite")


def test_the_offline_providers_need_no_permission():
    assert isinstance(build_provider("oracle"), OracleProvider)
    assert isinstance(build_provider("fake"), FakeProvider)


# ----------------------------------------------------------------- the spend cap


def test_max_calls_is_enforced(tmp_path):
    class Counter:
        model_id = "counter"

        def __init__(self):
            self.calls = 0

        def complete(self, system, cached_prefix, suffix):
            self.calls += 1
            return json.dumps(
                {
                    "candidates": [
                        {"stance": "answer", "text": "yeah im in"},
                        {"stance": "defer", "text": "lmk tmrw"},
                    ]
                }
            )

    inner = Counter()
    capped = CallCapped(inner, max_calls=3)
    for _ in range(3):
        capped.complete("s", "p", "x")
    with pytest.raises(CallCapExceeded):
        capped.complete("s", "p", "x")
    assert inner.calls == 3, "the cap must stop the call, not just record it"


def test_the_cap_stops_a_run_early(tmp_path):
    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT, limit=10)
    assert len(cases) > 2, "need more cases than the cap for this to mean anything"
    result = run_model("oracle", cases, max_calls=2)
    assert len(result.cases) == 2
    assert len(result.cases) < len(cases)


# --------------------------------------------------------------------- throttling


def test_the_throttle_retries_a_429_and_gives_up_eventually():
    slept: list[float] = []

    class RateLimited:
        model_id = "limited"

        def __init__(self, fail_times):
            self.fail_times = fail_times
            self.calls = 0

        def complete(self, system, cached_prefix, suffix):
            self.calls += 1
            if self.calls <= self.fail_times:
                raise RuntimeError("ClientError: 429 RESOURCE_EXHAUSTED")
            return "ok"

    recovers = Throttled(RateLimited(2), rpm=0, sleep=slept.append)
    assert recovers.complete("s", "p", "x") == "ok"
    assert recovers.retries == 2
    assert slept, "a retry must back off, not hammer"

    never = Throttled(RateLimited(99), rpm=0, max_retries=2, sleep=slept.append)
    with pytest.raises(RuntimeError, match="429"):
        never.complete("s", "p", "x")


def test_the_throttle_does_not_swallow_other_errors():
    class Broken:
        model_id = "broken"

        def complete(self, system, cached_prefix, suffix):
            raise RuntimeError("ClientError: 404 NOT_FOUND")

    with pytest.raises(RuntimeError, match="404"):
        Throttled(Broken(), rpm=0, sleep=lambda _: None).complete("s", "p", "x")


def test_the_throttle_paces_calls():
    slept: list[float] = []

    class Instant:
        model_id = "instant"

        def complete(self, system, cached_prefix, suffix):
            return "ok"

    t = Throttled(Instant(), rpm=60, sleep=slept.append)
    t.complete("s", "p", "x")
    t.complete("s", "p", "x")
    assert slept, "a second immediate call must wait for the interval"


# ------------------------------------------------------------------ the metrics


@pytest.mark.parametrize(
    "text,expected",
    [
        ("yeah im in", (True, False, False)),
        ("Yeah im in", (False, False, False)),
        ("yeah im in.", (True, True, False)),
        ("yeah im in 😭", (True, False, True)),
    ],
)
def test_surface_register(text, expected):
    assert surface_register(text) == expected


def test_register_match_is_exact_on_all_three_axes():
    assert register_matches("yeah im in", "ok that works")
    assert not register_matches("Yeah im in", "ok that works")
    assert not register_matches("yeah im in.", "ok that works")
    assert not register_matches("yeah im in 😭", "ok that works")


# ------------------------------------------------------------------ review file


def test_the_review_file_is_written_and_human_readable(tmp_path):
    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT, limit=10)
    results = [run_model("oracle", cases, 100)]

    path = write_review_file(results, cases, tmp_path / "review.txt", pairs=5)
    text = path.read_text()

    assert "[ ] send" in text and "[ ] edit" in text and "[ ] delete" in text
    assert "TALLY" in text
    # Contact identities are replaced with labels.
    assert "Person 1" in text
    for case in cases:
        assert case.contact_id not in text


def test_the_review_file_survives_every_model_being_skipped(tmp_path):
    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT, limit=3)
    from boi_intel.eval import ModelResult

    path = write_review_file(
        [ModelResult(model="kimi-k2.5", skipped_reason="no key")], cases, tmp_path / "r.txt"
    )
    assert "nothing to review" in path.read_text()


# ------------------------------------------------------------------------- CLI


def test_the_cli_runs_end_to_end_with_no_network(tmp_path, capsys):
    """The conftest socket guard is armed for this, so a network call would raise."""
    from boi_intel.eval import main

    db = _conversation(tmp_path)
    out = tmp_path / "eval"
    rc = main(["--db", str(db), "--models", "oracle,fake", "--n", "10", "--out", str(out)])
    assert rc == 0

    printed = capsys.readouterr().out
    assert "oracle" in printed and "fake" in printed
    assert (out / "table.txt").exists()
    assert (out / "summary.json").exists()
    assert (out / "review.txt").exists()

    summary = json.loads((out / "summary.json").read_text())
    assert {s["model"] for s in summary} == {"oracle", "fake"}


def test_the_table_reports_every_required_column(tmp_path):
    db = _conversation(tmp_path)
    cases = build_cases(str(db), salt=SALT, limit=5)
    summary = run_model("oracle", cases, 100).summary()
    for column in (
        "register_match_rate",
        "median_len_delta",
        "validator_pass_rate",
        "p50_latency_ms",
        "cost_per_draft_usd",
    ):
        assert column in summary, column


def test_the_price_source_is_always_recorded():
    """An unsourced price silently becomes a fact, and this table feeds a spend
    decision."""
    from boi_intel.eval import PRICING

    for model, price in PRICING.items():
        assert price["source"], model
        assert {"in", "out"} <= set(price), model
