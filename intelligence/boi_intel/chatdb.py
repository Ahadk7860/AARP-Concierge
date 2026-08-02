"""Read-only access to a Messages `chat.db`.

Two properties of this module are load-bearing and easy to get silently wrong:

1. **`mode=ro`, never `immutable=1`.** `immutable=1` tells SQLite the file cannot
   change, so it skips the write-ahead log entirely. On a live iCloud-syncing Mac that
   silently freezes the corpus at the last checkpoint and raises no error at all —
   the fixture database deliberately leaves a row in the WAL to catch exactly this.

2. **`is_from_me = 1` in the SQL.** The first of the three guards in CONTRACTS.md
   section 7. The serializer asserts it again over the same rows; both ship.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime

APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=UTC)
APPLE_EPOCH_OFFSET = int(APPLE_EPOCH.timestamp())

# Chat styles: 45 is one-to-one, 43 is a group. Voice packs are per contact, so a
# group thread cannot be attributed to one person and is excluded.
STYLE_ONE_TO_ONE = 45


@dataclass(frozen=True)
class SentMessage:
    """A single row the user wrote.

    `is_from_me` is carried rather than assumed so the serializer can assert it a
    second time, independently of the query that produced the row.
    """

    handle: str
    text: str
    ts_epoch: int
    is_from_me: int


def apple_ns_to_epoch(value: int) -> int:
    """Apple stores nanoseconds since 2001-01-01 on modern macOS, seconds on old
    databases. Both appear in the wild; the magnitude tells them apart."""
    if value is None:
        return 0
    if abs(value) > 10**11:
        value = value // 1_000_000_000
    return int(value) + APPLE_EPOCH_OFFSET


def epoch_to_iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def normalize_handle(handle: str) -> str:
    """Canonical form before hashing, so `+1 (555) 010-0001` and `+15550100001`
    produce the same contact_id."""
    h = (handle or "").strip().lower()
    if "@" in h:
        return h
    digits = re.sub(r"[^\d+]", "", h)
    if digits.startswith("+"):
        return digits
    if len(digits) == 10:
        return "+1" + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    return digits or h


def contact_id(handle: str, salt: bytes) -> str:
    """`h_` + HMAC(user_salt, normalized_handle).

    Per-user salt is the whole point: the same phone number yields a different id for
    every user, so cross-user joins are arithmetically unavailable rather than merely
    forbidden (CONTRACTS.md section 3).
    """
    digest = hmac.new(salt, normalize_handle(handle).encode("utf-8"), hashlib.sha256)
    return "h_" + digest.hexdigest()[:16]


def connect(db_path: str) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.text_factory = lambda b: b.decode("utf-8", errors="replace")
    return con


# `is_from_me = 1` is guard one of three. Tapbacks (associated_message_type != 0)
# carry no prose and would poison every length statistic.
_SENT_PREDICATE = """
      m.is_from_me = 1
  AND m.text IS NOT NULL
  AND TRIM(m.text) <> ''
  AND COALESCE(m.associated_message_type, 0) = 0
"""

_PER_CONTACT_SQL = f"""
SELECT h.id AS handle, m.text AS text, m.date AS date, m.is_from_me AS is_from_me
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c              ON c.ROWID = cmj.chat_id
JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
JOIN handle h            ON h.ROWID = chj.handle_id
WHERE {_SENT_PREDICATE}
  AND c.style = {STYLE_ONE_TO_ONE}
ORDER BY m.date ASC, m.ROWID ASC
"""

_ALL_SENT_SQL = f"""
SELECT '' AS handle, m.text AS text, m.date AS date, m.is_from_me AS is_from_me
FROM message m
WHERE {_SENT_PREDICATE}
ORDER BY m.date ASC, m.ROWID ASC
"""


def _rows(con: sqlite3.Connection, sql: str) -> list[SentMessage]:
    return [
        SentMessage(
            handle=r[0],
            text=r[1],
            ts_epoch=apple_ns_to_epoch(r[2]),
            is_from_me=int(r[3]),
        )
        for r in con.execute(sql)
    ]


def sent_by_contact(con: sqlite3.Connection) -> dict[str, list[SentMessage]]:
    """Every message the user wrote, grouped by the one-to-one thread it was in."""
    grouped: dict[str, list[SentMessage]] = {}
    for msg in _rows(con, _PER_CONTACT_SQL):
        grouped.setdefault(msg.handle, []).append(msg)
    return grouped


def all_sent(con: sqlite3.Connection) -> list[SentMessage]:
    """Every message the user wrote, across every thread — the global fallback corpus."""
    return _rows(con, _ALL_SENT_SQL)
