"""Building the eval set — and the one property the whole harness rests on.

**Ground truth is free.** For any thread where the user eventually replied, we already
have the message they actually sent. So the eval set builds itself: reconstruct the
state at time T, draft, and compare to what they really wrote. No labelling, no human
raters, and the target is the user's genuine voice rather than a rater's opinion of it.

The property that makes it worth anything:

> **The voice pack for a draft at time T contains no message dated at or after T.**

Leaking the future is the easiest way to get a fake-good score, and it is invisible in
the output — the numbers just come back better than they should be. Every pack here is
built from a slice that ends strictly before its own cutoff, and
`test_eval.py::test_no_future_leakage` asserts it over every generated case.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from boi_intel import chatdb
from boi_intel.facts import extract_facts, infer_topic
from boi_intel.gist import SqlGistProducer, classify
from boi_intel.threads import DAY_SECONDS, Message, _looks_like_a_question
from boi_intel.voice import MIN_SENT_FOR_CONTACT_PACK, _serialize

# Per-thread cap, so one chatty relationship cannot dominate the whole eval set.
MAX_CASES_PER_THREAD = 4

# The user has to have written enough BEFORE T for a voice pack to mean anything.
MIN_SENT_BEFORE_CUTOFF = MIN_SENT_FOR_CONTACT_PACK

# A reply days later is a reply. A reply three months later is a new conversation, and
# scoring a draft against it measures nothing.
MAX_REPLY_LAG_DAYS = 30


@dataclass(frozen=True)
class EvalCase:
    """One reconstructed moment, plus the reply the user actually sent."""

    contact_id: str
    cutoff_ts: int
    voice_pack: dict
    gist: dict
    actual_reply: str
    reply_lag_seconds: int

    @property
    def case_id(self) -> str:
        return f"{self.contact_id}@{self.cutoff_ts}"


def _thread_messages(con) -> dict[str, list[Message]]:
    from boi_intel.threads import _THREAD_SQL

    grouped: dict[str, list[Message]] = {}
    for handle, text, date, is_from_me in con.execute(_THREAD_SQL):
        grouped.setdefault(handle, []).append(
            Message(text=text, ts_epoch=chatdb.apple_ns_to_epoch(date), is_from_me=int(is_from_me))
        )
    return {h: sorted(m, key=lambda x: x.ts_epoch) for h, m in grouped.items()}


def _stats_before(messages: list[Message], cutoff_ts: int, pending: list[str]):
    """Thread statistics as they stood at `cutoff_ts`.

    Everything is derived from the slice strictly before the cutoff, plus the pending
    inbound run that is being replied to. Nothing after the cutoff is consulted.
    """
    from boi_intel.threads import REPLY_WINDOW_SECONDS, ThreadStats, _median

    before = [m for m in messages if m.ts_epoch < cutoff_ts]
    latencies: list[int] = []
    gaps: list[int] = []
    for prev, cur in zip(before, before[1:], strict=False):
        gap = cur.ts_epoch - prev.ts_epoch
        gaps.append(gap)
        if prev.is_from_me == 0 and cur.is_from_me == 1 and gap <= REPLY_WINDOW_SECONDS:
            latencies.append(gap)

    last = before[-1] if before else None
    ninety = 90 * DAY_SECONDS
    return ThreadStats(
        handle="",
        total_messages=len(before),
        sent_messages=sum(1 for m in before if m.is_from_me == 1),
        received_messages=sum(1 for m in before if m.is_from_me == 0),
        # As of the moment the user sat down to reply: the pending run started at the
        # cutoff, so "days silent" is measured from the last message before it.
        days_silent=max(0, (cutoff_ts - last.ts_epoch) // DAY_SECONDS) if last else 0,
        last_from_me=bool(last and last.is_from_me == 1),
        last_ts=last.ts_epoch if last else 0,
        first_ts=before[0].ts_epoch if before else 0,
        unanswered_question=any(_looks_like_a_question(t) for t in pending),
        median_reply_latency_seconds=_median(latencies),
        max_gap_days=(max(gaps) // DAY_SECONDS) if gaps else 0,
        messages_last_90d=sum(1 for m in before if cutoff_ts - m.ts_epoch <= ninety),
        messages_prior_90d=sum(1 for m in before if ninety < cutoff_ts - m.ts_epoch <= 2 * ninety),
        recent_inbound_text=pending,
    )


def _reply_points(messages: list[Message]) -> list[tuple[int, list[str], str, int]]:
    """Every `(cutoff_ts, pending_inbound, actual_reply, lag)` in one thread.

    A reply point is an inbound run the user *did* eventually answer. The cutoff is the
    first message of that run — the moment the obligation started.
    """
    points = []
    i = 0
    while i < len(messages):
        if messages[i].is_from_me != 0:
            i += 1
            continue
        run_start = i
        pending: list[str] = []
        while i < len(messages) and messages[i].is_from_me == 0:
            if messages[i].text:
                pending.append(messages[i].text)
            i += 1
        if i >= len(messages) or not pending:
            continue  # they never replied, or the run had no readable text
        reply = messages[i]
        if not reply.text:
            continue
        cutoff = messages[run_start].ts_epoch
        lag = reply.ts_epoch - cutoff
        if lag > MAX_REPLY_LAG_DAYS * DAY_SECONDS:
            continue
        points.append((cutoff, pending, reply.text, lag))
    return points


def build_cases(
    db_path: str,
    limit: int | None = None,
    salt: bytes | None = None,
    as_of: str = "2026-08-01T00:00:00Z",
) -> list[EvalCase]:
    """Reconstructed moments across every one-to-one thread, oldest cutoff first.

    Deterministic: threads in handle order, cutoffs in time order, no sampling.
    """
    from boi_intel.voice import resolve_salt

    salt = salt if salt is not None else resolve_salt()
    con = chatdb.connect(db_path)
    try:
        threads = _thread_messages(con)
    finally:
        con.close()

    producer = SqlGistProducer()
    cases: list[EvalCase] = []

    for handle in sorted(threads):
        messages = threads[handle]
        contact_id = chatdb.contact_id(handle, salt)
        taken = 0
        for cutoff, pending, reply, lag in _reply_points(messages):
            if taken >= MAX_CASES_PER_THREAD:
                break

            # ---- the no-leakage boundary. Everything below uses `before` only.
            before = [m for m in messages if m.ts_epoch < cutoff]
            sent_before = [m for m in before if m.is_from_me == 1 and m.text]
            if len(sent_before) < MIN_SENT_BEFORE_CUTOFF:
                continue

            pack = _serialize(
                [
                    chatdb.SentMessage(
                        handle=handle, text=m.text, ts_epoch=m.ts_epoch, is_from_me=1
                    )
                    for m in sent_before
                ],
                contact_id,
                "contact",
                as_of,
            )

            stats = _stats_before(messages, cutoff, pending)
            state = classify(stats) or "action_needed"
            gist = producer.produce(contact_id, stats, state, as_of)
            # Make the gist id unique per case so a provider keyed on it, and any cache,
            # cannot collapse two different moments into one.
            # sha256, NOT Python's hash(): PYTHONHASHSEED is randomised per process, so
            # `hash()` here made gist_ids differ between runs while the determinism test
            # — which builds both sets inside one process — could never see it. Same
            # shape as the cache-key test that passed against the pure helper while the
            # caller was wrong.
            digest = hashlib.sha256(f"{contact_id}|{cutoff}".encode()).hexdigest()
            gist["gist_id"] = f"g_{digest[:12]}"
            gist["facts"] = extract_facts(pending)
            gist["topic"] = infer_topic(pending)

            cases.append(
                EvalCase(
                    contact_id=contact_id,
                    cutoff_ts=cutoff,
                    voice_pack=pack,
                    gist=gist,
                    actual_reply=reply,
                    reply_lag_seconds=lag,
                )
            )
            taken += 1

    cases.sort(key=lambda c: (c.cutoff_ts, c.contact_id))
    return cases[:limit] if limit else cases
