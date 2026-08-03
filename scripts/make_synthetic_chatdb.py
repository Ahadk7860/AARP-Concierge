#!/usr/bin/env python3
"""Build a synthetic ~/Library/Messages/chat.db for development.

Why this exists: Track A and Track B both need a chat.db to reach a green Definition
of Done, and the only real one is the developer's own personal message history, which
must never be committed. This produces a database with the real schema and the real
awkward shapes -- NULL text rows, tapbacks, group chats, green-bubble threads, an
open WAL -- so most work is verifiable without touching anyone's messages.

    python3 scripts/make_synthetic_chatdb.py --out /tmp/boi-fixtures/chat.db

WHAT THIS CANNOT GIVE YOU: real `attributedBody` typedstream blobs. Apple's typedstream
is an undocumented NSArchiver format and a hand-rolled fake would let a broken decoder
pass. Rows here carry `attributedBody = NULL` and a marker in `text` instead.

So the typedstream decoder is verified against the developer's OWN chat.db, read-only,
with a metric rather than a fixture: the share of messages with no recoverable text must
fall from roughly 47% to under 2%. That check runs locally and commits nothing. See
Track A prompt 03.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import random
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)


def to_apple_ns(dt: datetime) -> int:
    return int((dt - APPLE_EPOCH).total_seconds() * 1_000_000_000)


SCHEMA = """
CREATE TABLE handle (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL, country TEXT, service TEXT NOT NULL,
  uncanonicalized_id TEXT, person_centric_id TEXT
);
CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT NOT NULL UNIQUE, style INTEGER, state INTEGER,
  account_id TEXT, chat_identifier TEXT, service_name TEXT,
  room_name TEXT, display_name TEXT, is_archived INTEGER DEFAULT 0,
  last_read_message_timestamp INTEGER DEFAULT 0
);
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT NOT NULL UNIQUE,
  text TEXT,
  handle_id INTEGER DEFAULT 0,
  service TEXT,
  account TEXT,
  date INTEGER,
  date_read INTEGER DEFAULT 0,
  date_delivered INTEGER DEFAULT 0,
  is_from_me INTEGER DEFAULT 0,
  is_read INTEGER DEFAULT 0,
  cache_has_attachments INTEGER DEFAULT 0,
  associated_message_guid TEXT,
  associated_message_type INTEGER DEFAULT 0,
  expressive_send_style_id TEXT,
  thread_originator_guid TEXT,
  attributedBody BLOB,
  was_delivered_quietly INTEGER DEFAULT 0,
  date_edited INTEGER DEFAULT 0,
  is_audio_message INTEGER DEFAULT 0
);
CREATE TABLE chat_message_join (
  chat_id INTEGER, message_id INTEGER, message_date INTEGER,
  PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE chat_handle_join (
  chat_id INTEGER, handle_id INTEGER, PRIMARY KEY (chat_id, handle_id)
);
CREATE TABLE attachment (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT NOT NULL UNIQUE, filename TEXT, mime_type TEXT, total_bytes INTEGER
);
CREATE TABLE message_attachment_join (
  message_id INTEGER, attachment_id INTEGER
);
CREATE INDEX message_date_idx ON message(date);
CREATE INDEX cmj_chat_idx ON chat_message_join(chat_id);
"""

PEOPLE = [
    # handle,           name,     service,    n_msgs, quiet_days, null_text_share, muted
    ("+15550100001", "Maya",  "iMessage", 1204, 12,  0.47, 0),
    ("+15550100002", "Yu",    "iMessage", 2380, 51,  0.47, 0),
    ("+15550100003", "Mom",   "iMessage", 3110,  2,  0.44, 0),
    ("+15550100004", "Dre",   "SMS",       1711, 198, 0.02, 0),
    ("+15550100005", "Priya", "iMessage",  640,  7,  0.51, 1),
    ("+15550100006", "Sam",   "iMessage",  180, 303, 0.46, 0),
]

USER_LINES = [
    "sorry been mia this week, work has been insane",
    "omg yes im so down. what day were u thinking",
    "lmk when ur free and ill come thru",
    "wait i totally forgot to reply to this",
    "ok that works for me",
    "ngl i completely spaced on that",
    "prob gonna be late but ill be there",
    "can i let u know tmrw",
    "haha yeah exactly",
    "im down whenever",
]
THEIR_LINES = [
    "are you still coming on the 14th",
    "we need to book by friday",
    "hey!! how have you been",
    "did you ever hear back about that",
    "call me when you get a sec",
    "no worries at all",
    "lmk what you think",
    "ok sounds good",
]


def build(out: pathlib.Path, seed: int = 7, leave_wal_open: bool = True,
          retention_cap_days: int | None = None) -> dict:
    rng = random.Random(seed)
    out.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        p = pathlib.Path(str(out) + suffix)
        if p.exists():
            p.unlink()

    con = sqlite3.connect(out)
    con.executescript("PRAGMA journal_mode=WAL;")
    con.executescript(SCHEMA)
    cur = con.cursor()

    now = datetime.now(timezone.utc)
    stats = {"messages": 0, "null_text": 0, "tapbacks": 0, "threads": 0}
    mguid = 0

    for handle, name, service, n, quiet_days, null_share, muted in PEOPLE:
        cur.execute(
            "INSERT INTO handle (id, service, country) VALUES (?,?,?)",
            (handle, service, "us"),
        )
        hid = cur.lastrowid
        cur.execute(
            "INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?,?,?,?)",
            (f"{service};-;{handle}", 45, handle, service),
        )
        cid = cur.lastrowid
        cur.execute("INSERT INTO chat_handle_join VALUES (?,?)", (cid, hid))
        stats["threads"] += 1

        # spread messages over a year, ending quiet_days ago
        end = now - timedelta(days=quiet_days)
        start = end - timedelta(days=350)
        if retention_cap_days is not None:
            # Apple's Keep Messages setting deletes everything older than the cap, so
            # every thread's first message lands on the boundary rather than on the day
            # the friendship actually started. That exact-boundary signature is the
            # thing prompt 06 detects and the reason first_contact_at must be nulled.
            floor = now - timedelta(days=retention_cap_days)
            start = max(start, floor)
        for i in range(n):
            frac = i / max(n - 1, 1)
            when = start + (end - start) * frac + timedelta(seconds=rng.randint(0, 3600))
            from_me = 1 if rng.random() < 0.46 else 0
            body = rng.choice(USER_LINES if from_me else THEIR_LINES)
            mguid += 1
            # ~47% of real messages have NULL text with the body in attributedBody.
            # We cannot synthesize a real typedstream, so mark the row instead.
            if rng.random() < null_share:
                text, attr = None, b"__SYNTHETIC_NO_TYPEDSTREAM__"
                stats["null_text"] += 1
            else:
                text, attr = body, None
            cur.execute(
                """INSERT INTO message
                   (guid, text, handle_id, service, date, date_delivered, date_read,
                    is_from_me, is_read, attributedBody, was_delivered_quietly)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (f"MSG-{mguid:07d}", text, 0 if from_me else hid, service,
                 to_apple_ns(when), to_apple_ns(when + timedelta(seconds=2)),
                 to_apple_ns(when + timedelta(seconds=rng.randint(5, 600))),
                 from_me, 1, attr, muted if from_me else 0),
            )
            mid = cur.lastrowid
            cur.execute(
                "INSERT INTO chat_message_join VALUES (?,?,?)",
                (cid, mid, to_apple_ns(when)),
            )
            stats["messages"] += 1

            # occasional tapback -- must be excluded from every metric
            if rng.random() < 0.04:
                mguid += 1
                cur.execute(
                    """INSERT INTO message
                       (guid, text, handle_id, service, date, is_from_me,
                        associated_message_guid, associated_message_type)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (f"MSG-{mguid:07d}", None, hid, service,
                     to_apple_ns(when + timedelta(seconds=30)), 0,
                     f"p:0/MSG-{mguid-1:07d}", 2000 + rng.randint(0, 5)),
                )
                tid = cur.lastrowid
                cur.execute(
                    "INSERT INTO chat_message_join VALUES (?,?,?)",
                    (cid, tid, to_apple_ns(when + timedelta(seconds=30))),
                )
                stats["tapbacks"] += 1
                stats["messages"] += 1

    # A TAPBACK THE USER SENT, quoting the other person. is_from_me = 1, and the body
    # carries their sentence verbatim. This is the case that defeats every guard except
    # an explicit tapback filter: the redaction scan sees no PII in it, and the verbatim
    # leak checker cannot match `Loved "..."` against the message it quotes.
    #
    # Until 3 Aug every synthetic tapback was is_from_me = 0 with text = NULL, so no
    # fixture could produce it and no test could catch it.
    mguid += 1
    when = now - timedelta(days=3)
    cur.execute(
        """INSERT INTO message
           (guid, text, handle_id, service, date, is_from_me,
            associated_message_guid, associated_message_type)
           VALUES (?,?,?,?,?,?,?,?)""",
        (f"MSG-{mguid:07d}",
         'Loved \u201cCANARY-INBOUND-PROSE-SHOULD-NEVER-REACH-AN-EXEMPLAR\u201d',
         1, "iMessage", to_apple_ns(when), 1, "p:0/MSG-0000001", 2000),
    )
    cur.execute("INSERT INTO chat_message_join VALUES (?,?,?)",
                (1, cur.lastrowid, to_apple_ns(when)))
    stats["messages"] += 1
    stats["sent_tapbacks_quoting_inbound"] = 1

    # one group chat -- style 43. Metrics must exclude these from 1:1 ranking.
    cur.execute(
        "INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES (?,?,?,?,?)",
        ("iMessage;+;chat999", 43, "chat999", "iMessage", "the group"),
    )
    gid = cur.lastrowid
    stats["threads"] += 1
    for i in range(60):
        mguid += 1
        when = now - timedelta(days=rng.randint(1, 200))
        cur.execute(
            """INSERT INTO message (guid, text, handle_id, service, date, is_from_me)
               VALUES (?,?,?,?,?,?)""",
            (f"MSG-{mguid:07d}", rng.choice(THEIR_LINES), rng.randint(1, len(PEOPLE)),
             "iMessage", to_apple_ns(when), 0),
        )
        cur.execute("INSERT INTO chat_message_join VALUES (?,?,?)",
                    (gid, cur.lastrowid, to_apple_ns(when)))
        stats["messages"] += 1

    con.commit()
    con.close()

    if leave_wal_open:
        _write_uncheckpointed_wal_row(out, mguid + 1, to_apple_ns(now))
        stats["messages"] += 1
        stats["wal_only_rows"] = 1
    return stats


def _write_uncheckpointed_wal_row(db: pathlib.Path, guid_n: int, when_ns: int) -> None:
    """Leave one committed row sitting in chat.db-wal, unmerged into the main file.

    This is the single most valuable property of the fixture. A reader that opens the
    database with `immutable=1` ignores the WAL and will not see this row; a reader
    using `mode=ro` will. That difference is how you prove the reader is not silently
    freezing the corpus -- the failure mode that produces no error, passes on a quiet
    test machine, and loses recent messages forever on a live iCloud-syncing Mac.

    Getting a WAL to survive is fiddly: SQLite checkpoints and deletes it when the
    last connection closes. So we write from a child process and kill it before it can
    close cleanly.
    """
    import subprocess
    import textwrap

    child = textwrap.dedent(f"""
        import os, signal, sqlite3
        con = sqlite3.connect({str(db)!r})
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA wal_autocheckpoint=0")
        cur = con.execute(
            "INSERT INTO message (guid, text, handle_id, service, date, is_from_me)"
            " VALUES (?,?,?,?,?,?)",
            ("MSG-{guid_n:07d}", "this row lives only in the WAL", 1, "iMessage",
             {when_ns}, 0),
        )
        # Join it to chat 1 so it survives the 1:1 filter. Without this the WAL-only row
        # is invisible to every filtered read, and the immutable=1 experiment would only
        # be provable on a raw count(*) that the product never calls -- the flagship
        # criterion covering a code path nobody ships.
        con.execute(
            "INSERT INTO chat_message_join VALUES (?,?,?)",
            (1, cur.lastrowid, {when_ns}),
        )
        con.commit()
        os.kill(os.getpid(), signal.SIGKILL)   # no close -> no checkpoint
    """)
    subprocess.run([sys.executable, "-c", child], check=False)
    if not pathlib.Path(str(db) + "-wal").exists():
        raise RuntimeError(
            "could not leave an open WAL; the immutable=1 experiment would be "
            "INCONCLUSIVE, which is not a pass"
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.environ.get("BOI_FIXTURE_CHATDB",
                                                    "/tmp/boi-fixtures/chat.db"))
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--checkpoint", action="store_true",
                    help="checkpoint the WAL instead of leaving rows in it")
    ap.add_argument("--retention-cap-days", type=int, default=None, metavar="N",
                    help="floor every thread's first message at exactly N days ago, the "
                         "way Apple's Keep Messages setting does. Use 365 to reproduce "
                         "the exact-boundary signature: on a real 94k corpus every "
                         "first_contact_at was floored at the cap, so a friendship that "
                         "began in 2019 reported as beginning a year ago. Needed to test "
                         "the first_contact_at null rule in CONTRACTS section 10.")
    a = ap.parse_args()
    stats = build(pathlib.Path(a.out), a.seed, leave_wal_open=not a.checkpoint,
                  retention_cap_days=a.retention_cap_days)
    print(f"wrote {a.out}")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    print("\nNOTE: attributedBody blobs are placeholders, not real typedstreams.")
    print("Verify the decoder against your own chat.db -- see Track A prompt 03.")


if __name__ == "__main__":
    main()
