"""Thread statistics from a `chat.db` — the SQL triage the whole gist path rests on.

Zero model, zero download, works on an Intel Mac with a full disk. CONTRACTS.md § 11
item 11 makes this the permanent fallback, so it is built first: if the local model
never lands, the product still works and the drafts are merely vaguer.

Two shapes of row need different handling and getting it backwards is silent:

- **Tapbacks** (`associated_message_type <> 0`) are excluded everywhere. They are not
  messages; counting them makes a dead thread look alive.
- **NULL-text rows** are real messages whose body lives in an undecodable
  `attributedBody` typedstream — roughly 47% of a real corpus (CONTRACTS.md § 10).
  They **count for timing and volume** and are **invisible to text analysis**. Dropping
  them from timing would report a thread as quiet when it is not, which is the exact
  failure mode of confidently saying something false about a person's friend.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime

from boi_intel.chatdb import STYLE_ONE_TO_ONE, apple_ns_to_epoch

DAY_SECONDS = 86_400

# A reply within this window is a reply; beyond it, the thread restarted.
REPLY_WINDOW_SECONDS = 7 * DAY_SECONDS
# How much inbound history the facts extractor is allowed to look at.
RECENT_INBOUND_LIMIT = 25


@dataclass(frozen=True)
class Message:
    text: str | None
    ts_epoch: int
    is_from_me: int


@dataclass
class ThreadStats:
    """Everything the gist producers need, and nothing that identifies anybody.

    `recent_inbound_text` is the one field carrying the other person's words. It stays
    on the Mac: it feeds facts extraction and the local model, and it is never
    serialized into a `gist.v1`.
    """

    handle: str
    total_messages: int = 0
    sent_messages: int = 0
    received_messages: int = 0
    days_silent: int = 0
    last_from_me: bool = False
    last_ts: int = 0
    first_ts: int = 0
    unanswered_question: bool = False
    median_reply_latency_seconds: int | None = None
    max_gap_days: int = 0
    messages_last_90d: int = 0
    messages_prior_90d: int = 0
    recent_inbound_text: list[str] = field(default_factory=list)

    @property
    def momentum(self) -> float:
        """Recent volume over prior volume. CONTRACTS.md § 6 is explicit that momentum
        is where the signal is and reciprocity is not — the observed reciprocity spread
        across 25 real relationships was 0.465–0.615, which carries almost nothing."""
        if self.messages_prior_90d == 0:
            return 1.0 if self.messages_last_90d == 0 else 2.0
        return self.messages_last_90d / self.messages_prior_90d


_THREAD_SQL = f"""
SELECT h.id           AS handle,
       m.text         AS text,
       m.date         AS date,
       m.is_from_me   AS is_from_me
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c               ON c.ROWID = cmj.chat_id
JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
JOIN handle h             ON h.ROWID = chj.handle_id
WHERE c.style = {STYLE_ONE_TO_ONE}
  AND COALESCE(m.associated_message_type, 0) = 0
ORDER BY m.date ASC, m.ROWID ASC
"""

QUESTION_WORDS = (
    "who", "what", "when", "where", "why", "how", "which", "are you", "did you",
    "do you", "can you", "could you", "would you", "will you", "are we", "should we",
    "you free", "you around", "you still", "any chance", "let me know",
)


def _looks_like_a_question(text: str) -> bool:
    """A question mark, or an interrogative opener without one.

    "wondering if youre around" is a question and this corpus is full of that shape;
    requiring `?` would under-count exactly the messages that need a reply.
    """
    low = (text or "").strip().lower()
    if not low:
        return False
    if "?" in low:
        return True
    return any(low.startswith(w) or f" {w}" in low for w in QUESTION_WORDS)


def _median(values: list[int]) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[(len(ordered) - 1) // 2]


def load_threads(con: sqlite3.Connection, now_epoch: int | None = None
                 ) -> dict[str, ThreadStats]:
    """Per-contact statistics for every one-to-one thread.

    `now_epoch` is injectable so tests are not a function of the wall clock.
    """
    now_epoch = now_epoch if now_epoch is not None else int(datetime.now(UTC).timestamp())

    grouped: dict[str, list[Message]] = {}
    for handle, text, date, is_from_me in con.execute(_THREAD_SQL):
        grouped.setdefault(handle, []).append(
            Message(text=text, ts_epoch=apple_ns_to_epoch(date), is_from_me=int(is_from_me))
        )

    return {h: _stats_for(h, msgs, now_epoch) for h, msgs in grouped.items() if msgs}


def _stats_for(handle: str, messages: list[Message], now_epoch: int) -> ThreadStats:
    messages = sorted(messages, key=lambda m: m.ts_epoch)
    last = messages[-1]

    latencies: list[int] = []
    gaps: list[int] = []
    for prev, cur in zip(messages, messages[1:], strict=False):
        gap = cur.ts_epoch - prev.ts_epoch
        gaps.append(gap)
        # A reply is an outbound message following an inbound one, within the window.
        if prev.is_from_me == 0 and cur.is_from_me == 1 and gap <= REPLY_WINDOW_SECONDS:
            latencies.append(gap)

    ninety = 90 * DAY_SECONDS
    last_90 = sum(1 for m in messages if now_epoch - m.ts_epoch <= ninety)
    prior_90 = sum(1 for m in messages if ninety < now_epoch - m.ts_epoch <= 2 * ninety)

    # Unanswered only if THEY spoke last and their final message wants an answer.
    # NULL-text rows cannot be inspected, so a thread ending in one is not claimed
    # to hold a question — degrade, never fabricate.
    unanswered = last.is_from_me == 0 and _looks_like_a_question(last.text or "")

    return ThreadStats(
        handle=handle,
        total_messages=len(messages),
        sent_messages=sum(1 for m in messages if m.is_from_me == 1),
        received_messages=sum(1 for m in messages if m.is_from_me == 0),
        days_silent=max(0, (now_epoch - last.ts_epoch) // DAY_SECONDS),
        last_from_me=last.is_from_me == 1,
        last_ts=last.ts_epoch,
        first_ts=messages[0].ts_epoch,
        unanswered_question=unanswered,
        median_reply_latency_seconds=_median(latencies),
        max_gap_days=(max(gaps) // DAY_SECONDS) if gaps else 0,
        messages_last_90d=last_90,
        messages_prior_90d=prior_90,
        recent_inbound_text=_pending_inbound(messages),
    )


def _pending_inbound(messages: list[Message]) -> list[str]:
    """The inbound messages the user has not answered — the run since they last wrote.

    This is the scope of "what you owe", so it is the right scope for facts extraction.
    Reading the whole inbound history instead would sweep up a date somebody mentioned
    a year ago and present it as a live deadline, which is a fabricated commitment sent
    in the user's own name.

    If the user spoke last there is no pending run; fall back to a short recent window
    so a fading or dormant thread still has something to draft from.
    """
    pending: list[str] = []
    for m in reversed(messages):
        if m.is_from_me == 1:
            break
        if m.text:
            pending.append(m.text)
    if pending:
        return pending[:RECENT_INBOUND_LIMIT]
    return [m.text for m in reversed(messages) if m.is_from_me == 0 and m.text][:10]
