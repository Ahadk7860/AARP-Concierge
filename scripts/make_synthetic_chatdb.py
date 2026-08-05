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

# ---------------------------------------------------------------- the rich profile
#
# `--profile rich` adds these on top of the six above. It exists because of one number:
# `buildCardModel` refuses any digest with fewer than **ten** ranked relationships
# (`not_enough_ranked`), so the six-person corpus can only ever produce a refusal card —
# and both strategy documents make "show 20 people the card" the stop condition for the
# whole product. Until this profile existed, that test was not merely unrun, it was
# unrunnable: this repo had never produced the artifact it requires.
#
# **The default is unchanged, byte for byte, and that is deliberate.** `relationships.count
# == 6` and `thread_count == 7` are asserted in Track A's `DigestTests`, and the six people
# encode specific awkward shapes (a muted thread, an SMS thread, per-person NULL-text
# shares). Rewriting another track's assertions so that my card renders is the wrong repair
# for "the fixture is too small".
#
# These are generated as CONVERSATIONS rather than as a uniform drip, because every
# archetype except `chapter` is defined by conversational structure the uniform generator
# cannot express: `initiation_ratio` counts who breaks a **six-hour** silence, and a thread
# with a message every 25 minutes has almost no openings to attribute to anyone.
#
#   archetype               what the classifier needs (Metrics.swift)
#   chapter                 >= 20 messages, quiet >= 180 days
#   fade                    momentum < 0.5, quiet >= 30 days
#   the_one_you_keep_waiting >= 3 unanswered questions FROM THE USER, user sent last,
#                           initiation >= 0.6
#   one_way_enthusiasm      initiation >= 0.7, >= 8 conversations opened
#   rising_fastest          momentum >= 1.5, quiet <= 14 days
#
# `kind` below is the archetype each person is SHAPED for, and it is a target rather than
# a promise: the classifier is Swift's and this script never asserts against it. What
# proves the shaping worked is a rendered `kind: standard` card, which is the point.
RICH_PEOPLE = [
    # handle,        name,      service,    kind,                      convos, quiet, span
    ("+15550100011", "Nina",    "iMessage", "chapter",                     16,  240,  190),
    ("+15550100012", "Theo",    "iMessage", "chapter",                     12,  310,  120),
    ("+15550100013", "Bex",     "SMS",      "chapter",                     11,  195,  150),
    ("+15550100014", "Ade",     "iMessage", "fade",                        26,   44,  330),
    ("+15550100015", "Kit",     "iMessage", "fade",                        22,   38,  300),
    ("+15550100016", "Jonah",   "iMessage", "waiting",                     18,    9,  260),
    ("+15550100017", "Remy",    "iMessage", "one_way",                     20,    5,  300),
    ("+15550100018", "Soraya",  "iMessage", "rising",                      24,    2,  260),
    ("+15550100019", "Ellis",   "iMessage", "steady",                      18,    6,  320),
    ("+15550100020", "Wren",    "SMS",      "steady",                      14,   11,  300),
]

# ---------------------------------------------------------------- per-person voices
#
# **One shared line pool for every person is why this fixture kept lying**, and it did it
# three separate times before anybody traced the three back to one cause:
#
#   1. every thread carried the same two date phrases, so no committing draft was ever
#      licensable — every draft that named a date named one the thread had outrun;
#   2. every draft opened `sorry been mia for ages`, because one `apology_openers` list
#      fed every voice pack;
#   3. the corpus could not clear the ranking bar at all, which is a different symptom of
#      the same thing — a fixture built from one voice cannot represent variation.
#
# **Variation is most of what this product measures.** A corpus that has none can only
# produce findings about itself. So each person gets their own inbound and outbound
# vocabulary, and `THEIR_LINES` / `USER_LINES` remain only as the fallback for the six
# default people, whose exact byte-for-byte output other tracks' tests depend on.
#
# `VOICES` is keyed by name. A person with no entry falls back to the shared pools.
VOICES: dict[str, dict[str, list[str]]] = {
    "Nina": {
        "theirs": ["that trip feels like a lifetime ago", "we should do it again sometime",
                   "hope the new place is treating you well"],
        "mine": ["ha we really did", "miss that", "ill send you the photos"],
    },
    "Theo": {
        "theirs": ["congrats again seriously", "let me know how it goes",
                   "proud of you man"],
        "mine": ["appreciate you", "will do", "thanks for checking in"],
    },
    "Bex": {
        "theirs": ["is the band still playing", "you around for the summer",
                   "we never did that thing"],
        "mine": ["not for a while", "im around", "we should"],
    },
    "Ade": {
        "theirs": ["did you ever hear back from them", "how did the interview go",
                   "still thinking about that offer?"],
        "mine": ["still waiting", "went ok i think", "ill know more soon"],
    },
    "Kit": {
        "theirs": ["how is the shoulder", "are you back at the gym yet",
                   "did the physio help"],
        "mine": ["getting there", "slowly", "back next week hopefully"],
    },
    "Jonah": {
        "theirs": ["no worries", "whenever suits", "all good"],
        "mine": ["sorry just seeing this", "ill get back to u", "been buried"],
    },
    "Remy": {
        "theirs": ["haha yeah", "true", "for sure"],
        "mine": ["thinking of you", "we should catch up properly",
                 "how have you been really"],
    },
    "Soraya": {
        # THE ONE RECENT THREAD WITH A DATE THAT IS GENUINELY AHEAD. Two days silent, and
        # `the 14th` has a horizon of 31 days, so it is still pending and a committing
        # draft is CORRECT here. This is the case the product is best at, and until now
        # the fixture could not represent it.
        "theirs": ["are we still on for the 14th", "let me know either way",
                   "looking forward to it"],
        "mine": ["yes! putting it in the calendar", "cant wait", "ill confirm the time"],
    },
    "Ellis": {
        "theirs": ["how was the weekend", "any plans this month", "hows work"],
        "mine": ["quiet one", "nothing yet", "busy but fine"],
    },
    "Wren": {
        "theirs": ["saw your post", "that looked fun", "we should get dinner"],
        "mine": ["it was", "yes lets", "im free most evenings"],
    },
}


def voice(name: str, from_me: bool, rng: random.Random) -> str:
    """A line in this person's own register, or the shared pool for the default six."""
    lines = VOICES.get(name, {}).get("mine" if from_me else "theirs")
    if not lines:
        return rng.choice(USER_LINES if from_me else THEIR_LINES)
    return rng.choice(lines)


# Questions, kept out of the shared line pools on purpose. `unansweredQuestions` keys on a
# trailing `?` AND on `text` being non-null, so a question that lands in the NULL-text share
# is invisible to the classifier — these rows always carry text.
USER_QUESTIONS = [
    "u around this weekend?",
    "did u ever pick a date?",
    "still good for the thing?",
    "hey did u see my last msg?",
    "we still on?",
]
THEIR_QUESTIONS = [
    "how did the move go?",
    "you free later?",
    "what did they say?",
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


# How each shape distributes its conversations over its own span, and who opens them.
#
# `weight` is sampled over the span, 0.0 = oldest, 1.0 = newest. Momentum is the last 90
# days over the 90 before, so "how many conversations landed late" IS the momentum knob:
# `fade` is back-loaded into the past and `rising` into the present.
SHAPES = {
    #            weight(frac)                       user opens   msgs per convo
    "chapter": (lambda f: 1.0,                          0.50,      (3, 7)),
    "fade":    (lambda f: 1.0 + 4.0 * (1.0 - f) ** 2,   0.55,      (3, 8)),
    "waiting": (lambda f: 1.0,                          0.75,      (2, 5)),
    "one_way": (lambda f: 1.0,                          0.90,      (2, 6)),
    "rising":  (lambda f: 1.0 + 6.0 * f ** 3,           0.50,      (4, 9)),
    "steady":  (lambda f: 1.0,                          0.50,      (3, 8)),
}


def _rich_threads(cur, rng: random.Random, now: datetime, stats: dict, mguid: int) -> int:
    """Ten more people, generated as conversations rather than as a uniform drip.

    Returns the running message-guid counter. Everything here is additive: the six
    default people are written before this runs and are not touched by it.
    """
    for handle, person, service, kind, convos, quiet_days, span_days in RICH_PEOPLE:
        weight, user_opens, (lo, hi) = SHAPES[kind]

        cur.execute("INSERT INTO handle (id, service, country) VALUES (?,?,?)",
                    (handle, service, "us"))
        hid = cur.lastrowid
        cur.execute(
            "INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?,?,?,?)",
            (f"{service};-;{handle}", 45, handle, service),
        )
        cid = cur.lastrowid
        cur.execute("INSERT INTO chat_handle_join VALUES (?,?)", (cid, hid))
        stats["threads"] += 1

        end = now - timedelta(days=quiet_days)
        start = end - timedelta(days=span_days)
        # Sample conversation openings from the shape's weighting, then sort: a
        # conversation is a burst in time and the burst order has to be chronological or
        # `initiation_ratio` attributes openings to whoever happened to be written first.
        bins = [i / 199 for i in range(200)]
        picks = rng.choices(bins, weights=[weight(f) for f in bins], k=convos)
        picks.sort()

        # `the_one_you_keep_waiting` needs >= 3 questions from the USER that nobody
        # answered, and the user holding the last word. Those are the final conversations
        # of the thread, so nothing arrives inside the answer window afterwards.
        unanswered_at = set(range(convos - 4, convos)) if kind == "waiting" else set()

        for index, frac in enumerate(picks):
            opened_at = start + (end - start) * frac
            from_me = rng.random() < user_opens
            n = rng.randint(lo, hi)
            when = opened_at
            for turn in range(n):
                # Real conversations alternate but not perfectly; a run of two from one
                # side is what makes `initiation_ratio` different from a volume count.
                if turn > 0:
                    from_me = from_me if rng.random() < 0.25 else not from_me
                    when = when + timedelta(seconds=rng.randint(40, 900))
                body = voice(person, from_me, rng)
                text, attr = body, None
                if rng.random() < 0.30:
                    text, attr = None, b"__SYNTHETIC_NO_TYPEDSTREAM__"
                    stats["null_text"] += 1
                mguid += 1
                cur.execute(
                    """INSERT INTO message
                       (guid, text, handle_id, service, date, date_delivered, date_read,
                        is_from_me, is_read, attributedBody, was_delivered_quietly)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (f"MSG-{mguid:07d}", text, 0 if from_me else hid, service,
                     to_apple_ns(when), to_apple_ns(when + timedelta(seconds=2)),
                     to_apple_ns(when + timedelta(seconds=rng.randint(5, 600))),
                     1 if from_me else 0, 1, attr, 0),
                )
                cur.execute("INSERT INTO chat_message_join VALUES (?,?,?)",
                            (cid, cur.lastrowid, to_apple_ns(when)))
                stats["messages"] += 1

            # A trailing question, never NULL-text: `unansweredQuestions` reads `text`
            # and a question hidden in the attributedBody share cannot be counted.
            if index in unanswered_at:
                when = when + timedelta(seconds=rng.randint(600, 4000))
                mguid += 1
                cur.execute(
                    """INSERT INTO message
                       (guid, text, handle_id, service, date, is_from_me, is_read)
                       VALUES (?,?,?,?,?,?,?)""",
                    (f"MSG-{mguid:07d}", rng.choice(USER_QUESTIONS), 0, service,
                     to_apple_ns(when), 1, 1),
                )
                cur.execute("INSERT INTO chat_message_join VALUES (?,?,?)",
                            (cid, cur.lastrowid, to_apple_ns(when)))
                stats["messages"] += 1
                stats["unanswered_user_questions"] = \
                    stats.get("unanswered_user_questions", 0) + 1
            elif rng.random() < 0.25:
                # Questions from them, answered, so the two counters are not the same
                # number wearing two names.
                when = when + timedelta(seconds=rng.randint(60, 900))
                for asker_is_me, line in ((0, rng.choice(THEIR_QUESTIONS)),
                                          (1, voice(person, True, rng))):
                    mguid += 1
                    cur.execute(
                        """INSERT INTO message
                           (guid, text, handle_id, service, date, is_from_me, is_read)
                           VALUES (?,?,?,?,?,?,?)""",
                        (f"MSG-{mguid:07d}", line, 0 if asker_is_me else hid, service,
                         to_apple_ns(when), asker_is_me, 1),
                    )
                    cur.execute("INSERT INTO chat_message_join VALUES (?,?,?)",
                                (cid, cur.lastrowid, to_apple_ns(when)))
                    stats["messages"] += 1
                    when = when + timedelta(seconds=rng.randint(120, 3000))
    return mguid


ADDRESS_BOOK_SCHEMA = """
CREATE TABLE ZABCDRECORD (
  Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT
);
CREATE TABLE ZABCDPHONENUMBER (
  Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT
);
CREATE TABLE ZABCDEMAILADDRESS (
  Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT
);
"""

# Last names, so the directory carries the two-part display the reader joins. Kept here
# rather than in PEOPLE because PEOPLE is load-bearing for other tracks' tests.
SURNAMES = {
    "Maya": "Okonjo", "Yu": "Chen", "Mom": "", "Dre": "Salinas", "Priya": "Raman",
    "Sam": "Whitfield", "Nina": "Alvarez", "Theo": "Baptiste", "Bex": "Lindqvist",
    "Ade": "Oyelaran", "Kit": "Moreau", "Jonah": "Feldman", "Remy": "Duval",
    "Soraya": "Nazari", "Ellis": "Tran", "Wren": "Halloway",
}


def write_address_book(path: pathlib.Path, profile: str = "minimal") -> int:
    """A synthetic `AddressBook-v22.abcddb` naming the same people the corpus texts.

    **This is what turns the card from a debugging artifact into the thing the kill test
    is about.** Without it every archetype on the card is headed `+15550100014`, because
    `ContactResolver` falls back to the handle when no directory names it — and nobody
    screenshots a phone number. The names were always in this file; they just had nowhere
    to go.

    Written to the path `AddressBookDirectory.discover()` looks in, under whatever HOME
    the caller sets, so no Swift changes and no new flag: point a run's HOME at the
    directory holding this and the Mac finds it exactly as it finds a real one.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    con.executescript(ADDRESS_BOOK_SCHEMA)
    people = list(PEOPLE) + (
        [(h, n, s, None, None, None, None) for h, n, s, _k, _c, _q, _sp in RICH_PEOPLE]
        if profile == "rich" else []
    )
    for record, person in enumerate(people, start=1):
        handle, name = person[0], person[1]
        con.execute(
            "INSERT INTO ZABCDRECORD (Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION)"
            " VALUES (?,?,?,?)",
            (record, name, SURNAMES.get(name, ""), None),
        )
        con.execute(
            "INSERT INTO ZABCDPHONENUMBER (Z_PK, ZOWNER, ZFULLNUMBER) VALUES (?,?,?)",
            (record, record, handle),
        )
    con.commit()
    con.close()
    return len(people)


def build(out: pathlib.Path, seed: int = 7, leave_wal_open: bool = True,
          retention_cap_days: int | None = None, profile: str = "minimal") -> dict:
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

    if profile == "rich":
        mguid = _rich_threads(cur, rng, now, stats, mguid)

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
    ap.add_argument("--profile", choices=("minimal", "rich"), default="minimal",
                    help="minimal (default) is the original six people, unchanged byte "
                         "for byte. rich adds ten more so the corpus clears the card "
                         "renderer's ten-ranked-relationship bar -- without it every "
                         "card this repo can produce is a refusal card, which makes the "
                         "kill test unrunnable rather than merely unrun.")
    ap.add_argument("--contacts-out", default=None, metavar="PATH",
                    help="also write a synthetic AddressBook-v22.abcddb naming the same "
                         "people. Without one the card headlines every archetype with a "
                         "phone number, which is not an artifact anybody screenshots.")
    a = ap.parse_args()
    stats = build(pathlib.Path(a.out), a.seed, leave_wal_open=not a.checkpoint,
                  retention_cap_days=a.retention_cap_days, profile=a.profile)
    if a.contacts_out:
        stats["contacts"] = write_address_book(pathlib.Path(a.contacts_out), a.profile)
    print(f"wrote {a.out}")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    print("\nNOTE: attributedBody blobs are placeholders, not real typedstreams.")
    print("Verify the decoder against your own chat.db -- see Track A prompt 03.")


if __name__ == "__main__":
    main()
