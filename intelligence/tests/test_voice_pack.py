"""Voice-pack builder tests.

The first test in this file is the one that matters. Everything else here is
correctness; that one is the privacy claim. It is a frozen anchor — see CONTRACTS.md
section 7 and prompt 01. Do not weaken, skip, or narrow its input to make a run green.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
from datetime import UTC

import pytest
from boi_intel import chatdb
from boi_intel.voice import (
    MAX_EXEMPLAR_CHARS,
    MAX_EXEMPLARS,
    MIN_SENT_FOR_CONTACT_PACK,
    VoicePackLeakError,
    build_packs,
    diff_packs,
    main,
    write_packs,
)
from conftest import make_db, received, sent

ROOT = pathlib.Path(__file__).resolve().parents[2]

# Long enough to be unmistakable in a diff, and nothing like any sent line.
INBOUND_CANARY = "zzq-inbound-canary-string-that-must-never-appear-in-a-pack"


def _texts(pack: dict) -> str:
    return json.dumps(pack, ensure_ascii=False)


# --------------------------------------------------------------- the privacy anchor


def test_inbound_messages_never_reach_a_pack(tmp_path):
    """Guard one and guard two, end to end.

    Verified to bite: with the `is_from_me` filter removed from the SQL, the
    serializer raises; with both removed, this assertion fails. Both runs are in the
    prompt 01 report.
    """
    db = make_db(tmp_path / "chat.db", [
        sent("ok that works for me"),
        received(INBOUND_CANARY),
        sent("lmk when ur free"),
        received(INBOUND_CANARY + " again"),
        sent("im down whenever"),
        sent("haha yeah exactly"),
        sent("prob gonna be late"),
        received("are you still coming on the 14th"),
    ])

    packs = build_packs(str(db), as_of="2026-08-01T00:00:00Z")

    assert len(packs) >= 2, "expected a per-contact pack plus the global fallback"
    for name, pack in packs.items():
        assert INBOUND_CANARY not in _texts(pack), f"inbound text leaked into {name}"
        assert "are you still coming" not in _texts(pack), f"inbound text leaked into {name}"


def test_serializer_rejects_a_row_the_user_did_not_write():
    """Guard two on its own, with the query bypassed entirely."""
    from boi_intel.voice import _serialize

    rows = [
        chatdb.SentMessage("+1555", "ok that works", 1_700_000_000, 1),
        chatdb.SentMessage("+1555", INBOUND_CANARY, 1_700_000_100, 0),
    ]
    with pytest.raises(VoicePackLeakError):
        _serialize(rows, "h_00000000", "contact", "2026-08-01T00:00:00Z")


def test_the_leak_checker_itself_passes_on_generated_packs(tmp_path):
    db = make_db(tmp_path / "chat.db", [
        sent("ok that works for me"), sent("lmk when ur free"),
        sent("im down whenever"), sent("haha yeah exactly"),
        sent("prob gonna be late"), received("call me when you get a sec"),
    ])
    written = write_packs(build_packs(str(db), as_of="2026-08-01T00:00:00Z"),
                          str(tmp_path / "out"))
    for path in written:
        r = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "check_voice_pack_leak.py"),
             "--db", str(db), "--pack", str(path)],
            capture_output=True, text=True,
        )
        assert r.returncode == 0, r.stdout + r.stderr


# --------------------------------------------------------------------- redaction


def test_exemplars_carry_no_phone_email_or_amount(tmp_path):
    db = make_db(tmp_path / "chat.db", [
        sent("call me at +1 (555) 010-0042 when you land"),
        sent("my email is skyler.luk@example.com if thats easier"),
        sent("it came out to $1,240.50 total which is wild"),
        sent("i live at 1600 Amphitheatre Pkwy now"),
        sent("Jordan Feldman said he'd cover the rest"),
        sent("ok cool"),
    ])
    packs = build_packs(str(db), as_of="2026-08-01T00:00:00Z")

    for name, pack in packs.items():
        blob = _texts(pack)
        assert "555" not in blob, f"phone digits survived redaction in {name}"
        assert "010-0042" not in blob, f"phone survived redaction in {name}"
        assert "@example.com" not in blob, f"email survived redaction in {name}"
        assert "1,240.50" not in blob, f"amount survived redaction in {name}"
        assert "$" not in blob, f"amount marker survived redaction in {name}"
        assert "Amphitheatre" not in blob, f"street address survived redaction in {name}"
        assert "Jordan Feldman" not in blob, f"third-party name survived redaction in {name}"

    exemplars = packs["global_fallback.json"]["exemplars"]
    assert any("[phone]" in e for e in exemplars)
    assert any("[email]" in e for e in exemplars)
    assert any("[amount]" in e for e in exemplars)


# ------------------------------------------------------------------------- limits


def test_no_pack_exceeds_the_exemplar_or_length_limits(tmp_path):
    long_line = "so anyway " * 60  # 600 chars, well past the 200-char cap
    messages = [sent(f"{long_line} #{i}") for i in range(120)]
    messages += [sent(f"short one {i}") for i in range(120)]
    db = make_db(tmp_path / "chat.db", messages, spacing_hours=1)

    packs = build_packs(str(db), as_of="2026-08-01T00:00:00Z")
    assert len(packs) >= 2
    for name, pack in packs.items():
        assert len(pack["exemplars"]) <= MAX_EXEMPLARS, name
        assert pack["n_exemplars"] == len(pack["exemplars"]), name
        for e in pack["exemplars"]:
            assert len(e) <= MAX_EXEMPLAR_CHARS, f"{name}: {len(e)} chars"


def test_sampling_spans_the_length_distribution(tmp_path):
    """Forty copies of the median message would be a technically-passing pack that
    teaches a drafter nothing."""
    messages = [sent("x" * (5 + i) + f" m{i}") for i in range(150)]
    corpus_lengths = sorted(len(m[1]) for m in messages)
    db = make_db(tmp_path / "chat.db", messages, spacing_hours=1)
    pack = build_packs(str(db), as_of="2026-08-01T00:00:00Z")["global_fallback.json"]
    lengths = [len(e) for e in pack["exemplars"]]

    assert len(pack["exemplars"]) == MAX_EXEMPLARS
    # The sample must reach into both tails of the corpus, not cluster at the median.
    p5 = corpus_lengths[len(corpus_lengths) // 20]
    p95 = corpus_lengths[-len(corpus_lengths) // 20]
    assert min(lengths) <= p5, (min(lengths), p5)
    assert max(lengths) >= p95, (max(lengths), p95)


# -------------------------------------------------------------------- determinism


def test_building_twice_yields_the_same_version(tmp_path):
    db = make_db(tmp_path / "chat.db", [
        sent("ok that works for me"), sent("lmk when ur free"),
        sent("im down whenever"), sent("haha yeah exactly"),
        sent("prob gonna be late"),
    ])
    first = build_packs(str(db), as_of="2026-08-01T00:00:00Z")
    second = build_packs(str(db), as_of="2026-09-14T11:22:33Z")

    assert set(first) == set(second)
    for name in first:
        assert first[name]["voice_pack_version"] == second[name]["voice_pack_version"], name


def test_changing_one_exemplar_changes_the_version(tmp_path):
    base = [
        sent("ok that works for me"), sent("lmk when ur free"),
        sent("im down whenever"), sent("haha yeah exactly"),
        sent("prob gonna be late"),
    ]
    a = build_packs(str(make_db(tmp_path / "a.db", base)),
                    as_of="2026-08-01T00:00:00Z")
    edited = list(base)
    edited[2] = sent("im down whenever honestly")
    b = build_packs(str(make_db(tmp_path / "b.db", edited)),
                    as_of="2026-08-01T00:00:00Z")

    assert (a["global_fallback.json"]["voice_pack_version"]
            != b["global_fallback.json"]["voice_pack_version"])


def test_version_matches_the_schema_pattern(tmp_path):
    import re

    db = make_db(tmp_path / "chat.db", [sent(f"line number {i}") for i in range(8)])
    for pack in build_packs(str(db), as_of="2026-08-01T00:00:00Z").values():
        assert re.fullmatch(r"vp_[0-9a-f]{8,16}", pack["voice_pack_version"])


# ------------------------------------------------------------------ thin contacts


def test_a_contact_under_five_sent_messages_gets_no_pack(tmp_path):
    db = make_db(tmp_path / "chat.db", [
        sent("hey"), sent("you around"), sent("ok np"), sent("later"),
        received("sorry just seeing this"), received("all good"),
    ])
    assert MIN_SENT_FOR_CONTACT_PACK == 5

    packs = build_packs(str(db), as_of="2026-08-01T00:00:00Z")
    assert list(packs) == ["global_fallback.json"]
    assert packs["global_fallback.json"]["contact_id"] is None
    assert packs["global_fallback.json"]["scope"] == "global"
    assert packs["global_fallback.json"]["exemplars"], "the fallback still has to carry a voice"


def test_five_sent_messages_is_enough(tmp_path):
    db = make_db(tmp_path / "chat.db", [
        sent("hey"), sent("you around"), sent("ok np"), sent("later"),
        sent("one more"), received("all good"),
    ])
    packs = build_packs(str(db), as_of="2026-08-01T00:00:00Z")
    contact_packs = [p for p in packs.values() if p["scope"] == "contact"]
    assert len(contact_packs) == 1
    assert contact_packs[0]["contact_id"].startswith("h_")


# ----------------------------------------------------------------------- compare


def test_compare_reports_nothing_for_a_pack_against_itself(tmp_path):
    db = make_db(tmp_path / "chat.db", [sent(f"line {i}") for i in range(8)])
    pack = build_packs(str(db), as_of="2026-08-01T00:00:00Z")["global_fallback.json"]
    assert diff_packs(pack, json.loads(json.dumps(pack))) == []


def test_compare_names_the_field_that_differs(tmp_path):
    db = make_db(tmp_path / "chat.db", [sent(f"line {i}") for i in range(8)])
    pack = build_packs(str(db), as_of="2026-08-01T00:00:00Z")["global_fallback.json"]
    edited = json.loads(json.dumps(pack))
    edited["register"]["median_len_chars"] = 999

    diffs = diff_packs(pack, edited)
    assert len(diffs) == 1
    assert diffs[0].startswith("register.median_len_chars:")
    assert "999" in diffs[0]


def test_compare_reports_an_edited_exemplar_by_index(tmp_path):
    db = make_db(tmp_path / "chat.db", [sent(f"line {i}") for i in range(8)])
    pack = build_packs(str(db), as_of="2026-08-01T00:00:00Z")["global_fallback.json"]
    edited = json.loads(json.dumps(pack))
    edited["exemplars"][0] = "something else entirely"

    diffs = diff_packs(pack, edited)
    assert any(d.startswith("exemplars[0]:") for d in diffs)


def test_compare_ignore_skips_only_the_named_field(tmp_path):
    db = make_db(tmp_path / "chat.db", [sent(f"line {i}") for i in range(8)])
    pack = build_packs(str(db), as_of="2026-08-01T00:00:00Z")["global_fallback.json"]
    edited = json.loads(json.dumps(pack))
    edited["as_of"] = "2030-01-01T00:00:00Z"
    edited["scope"] = "contact"

    assert [d for d in diff_packs(pack, edited, ignore=("as_of",))
            if d.startswith("as_of")] == []
    assert any(d.startswith("scope:") for d in diff_packs(pack, edited, ignore=("as_of",)))


# --------------------------------------------------------------------------- CLI


def test_cli_writes_one_file_per_contact_plus_the_global_fallback(tmp_path):
    db = make_db(tmp_path / "chat.db", [sent(f"line number {i}") for i in range(8)])
    out = tmp_path / "out"

    assert main(["--db", str(db), "--out", str(out)]) == 0
    names = sorted(p.name for p in out.glob("*.json"))
    assert "global_fallback.json" in names
    assert len(names) == 2
    assert any(n.startswith("voice_pack_h_") for n in names), names


def test_cli_compare_exit_codes(tmp_path):
    db = make_db(tmp_path / "chat.db", [sent(f"line {i}") for i in range(8)])
    out = tmp_path / "out"
    main(["--db", str(db), "--out", str(out)])
    a = out / "global_fallback.json"
    b = tmp_path / "edited.json"
    doc = json.loads(a.read_text())
    doc["register"]["emoji_rate"] = 0.9
    b.write_text(json.dumps(doc))

    assert main(["--compare", str(a), str(a)]) == 0
    assert main(["--compare", str(b), "--pack", str(a)]) == 1


# ------------------------------------------------------------------------ schema


def test_every_generated_pack_validates_against_the_frozen_schema(tmp_path):
    db = make_db(tmp_path / "chat.db", [
        sent("sorry been mia this week 😭"), sent("omg yes im so down"),
        sent("lmk when ur free and ill come thru"), sent("Ok. That works for me."),
        sent("prob gonna be late but ill be there"), sent("can i let u know tmrw?"),
        received("are you still coming on the 14th"),
    ])
    out = tmp_path / "out"
    written = write_packs(build_packs(str(db), as_of="2026-08-01T00:00:00Z"), str(out))
    assert written

    for path in written:
        r = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "validate_fixtures.py"),
             "voice_pack.v1", str(path)],
            capture_output=True, text=True,
        )
        assert r.returncode == 0, r.stdout + r.stderr


def test_contact_id_is_salted_per_user(tmp_path):
    """Two users must not derive the same id for the same phone number — the whole
    cross-user-join defence in CONTRACTS.md section 3 rests on this."""
    a = chatdb.contact_id("+15550100001", b"salt-a")
    b = chatdb.contact_id("+15550100001", b"salt-b")
    assert a != b
    assert a == chatdb.contact_id("+1 (555) 010-0001", b"salt-a")


def test_group_chats_do_not_produce_a_contact_pack(tmp_path):
    """A group thread cannot be attributed to one person, so it must not become a
    per-contact pack — but the user's own words in it are still their voice."""
    import sqlite3
    from datetime import datetime, timedelta

    from conftest import SCHEMA, to_apple_ns

    db = tmp_path / "chat.db"
    con = sqlite3.connect(db)
    con.executescript(SCHEMA)
    cur = con.cursor()
    cur.execute("INSERT INTO handle (id, service, country) VALUES (?,?,?)",
                ("+15550100777", "iMessage", "us"))
    hid = cur.lastrowid
    cur.execute(
        "INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?,?,?,?)",
        ("iMessage;+;chat777", 43, "chat777", "iMessage"),
    )
    cid = cur.lastrowid
    cur.execute("INSERT INTO chat_handle_join VALUES (?,?)", (cid, hid))
    start = datetime(2026, 1, 1, tzinfo=UTC)
    for i in range(9):
        when = start + timedelta(hours=i)
        cur.execute(
            """INSERT INTO message (guid, text, handle_id, service, date, is_from_me)
               VALUES (?,?,?,?,?,?)""",
            (f"G-{i}", f"group line {i}", 0, "iMessage", to_apple_ns(when), 1),
        )
        cur.execute("INSERT INTO chat_message_join VALUES (?,?,?)",
                    (cid, cur.lastrowid, to_apple_ns(when)))
    con.commit()
    con.close()

    packs = build_packs(str(db), as_of="2026-08-01T00:00:00Z")
    assert list(packs) == ["global_fallback.json"]
    assert len(packs["global_fallback.json"]["exemplars"]) == 9


def test_tapbacks_are_excluded_from_the_corpus(tmp_path):
    """A tapback carries no prose. Counting one as a sent message drags every length
    statistic toward zero."""
    import sqlite3
    from datetime import datetime, timedelta

    from conftest import SCHEMA, to_apple_ns

    db = tmp_path / "chat.db"
    con = sqlite3.connect(db)
    con.executescript(SCHEMA)
    cur = con.cursor()
    cur.execute("INSERT INTO handle (id, service, country) VALUES (?,?,?)",
                ("+15550100888", "iMessage", "us"))
    hid = cur.lastrowid
    cur.execute(
        "INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?,?,?,?)",
        ("iMessage;-;+15550100888", 45, "+15550100888", "iMessage"),
    )
    cid = cur.lastrowid
    cur.execute("INSERT INTO chat_handle_join VALUES (?,?)", (cid, hid))
    start = datetime(2026, 1, 1, tzinfo=UTC)
    for i in range(6):
        when = start + timedelta(hours=i)
        cur.execute(
            """INSERT INTO message (guid, text, handle_id, service, date, is_from_me)
               VALUES (?,?,?,?,?,?)""",
            (f"M-{i}", f"a real sent message number {i}", 0, "iMessage",
             to_apple_ns(when), 1),
        )
        cur.execute("INSERT INTO chat_message_join VALUES (?,?,?)",
                    (cid, cur.lastrowid, to_apple_ns(when)))
    cur.execute(
        """INSERT INTO message (guid, text, handle_id, service, date, is_from_me,
                                associated_message_guid, associated_message_type)
           VALUES (?,?,?,?,?,?,?,?)""",
        ("TAP-1", "Loved “a real sent message number 0”", 0, "iMessage",
         to_apple_ns(start + timedelta(hours=7)), 1, "p:0/M-0", 2000),
    )
    cur.execute("INSERT INTO chat_message_join VALUES (?,?,?)",
                (cid, cur.lastrowid, to_apple_ns(start + timedelta(hours=7))))
    con.commit()
    con.close()

    pack = build_packs(str(db), as_of="2026-08-01T00:00:00Z")["global_fallback.json"]
    assert len(pack["exemplars"]) == 6
    assert not any("Loved" in e for e in pack["exemplars"])
