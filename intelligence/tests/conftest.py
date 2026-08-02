"""Test helpers for building small, purpose-built chat.db files.

The schema is imported from `scripts/make_synthetic_chatdb.py` rather than restated
here. A second copy would drift, and a test that passes against a stale schema proves
nothing about the reader that runs against the real one.

This module also blocks outbound sockets for the whole suite — see `_no_network`.
"""

from __future__ import annotations

import importlib.util
import pathlib
import socket
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=UTC)


class NetworkUseInTests(RuntimeError):
    """A unit test tried to open a socket."""


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Make "the unit suite never touches the network" structural, not a claim.

    CONTRACTS.md § 9 is explicit that live calls belong in the eval harness and that the
    default test path is `FakeProvider`. A suite that quietly acquires a network
    dependency does not fail loudly — it fails *randomly*, at a third of the throughput
    with three agents on one key, and reads as flaky tests rather than as
    misconfiguration. So the socket is taken away rather than trusted.

    This binds in-process sockets only. The suite shells out to `validate_fixtures.py`
    and `check_voice_pack_leak.py` in subprocesses; both only read local files.
    """

    def blocked(self, *args, **kwargs):
        raise NetworkUseInTests(
            "the unit suite must not open a socket — use FakeProvider (CONTRACTS.md section 9)"
        )

    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)


def _load_schema() -> str:
    spec = importlib.util.spec_from_file_location(
        "_make_synthetic_chatdb", ROOT / "scripts" / "make_synthetic_chatdb.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module.SCHEMA


SCHEMA = _load_schema()


def to_apple_ns(dt: datetime) -> int:
    return int((dt - APPLE_EPOCH).total_seconds() * 1_000_000_000)


def make_db(
    path: pathlib.Path,
    messages: list[tuple[str, str | None, int]],
    handle: str = "+15550100999",
    service: str = "iMessage",
    start: datetime | None = None,
    spacing_hours: int = 6,
) -> pathlib.Path:
    """Build a one-to-one thread.

    `messages` is a list of `(handle, text, is_from_me)` triples; the handle column is
    ignored for the single-thread case and exists so callers read as data, not as
    positional trivia.
    """
    start = start or datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()

    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    cur = con.cursor()
    cur.execute("INSERT INTO handle (id, service, country) VALUES (?,?,?)", (handle, service, "us"))
    hid = cur.lastrowid
    cur.execute(
        "INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?,?,?,?)",
        (f"{service};-;{handle}", 45, handle, service),
    )
    cid = cur.lastrowid
    cur.execute("INSERT INTO chat_handle_join VALUES (?,?)", (cid, hid))

    for i, (_h, text, from_me) in enumerate(messages):
        when = start + timedelta(hours=spacing_hours * i)
        cur.execute(
            """INSERT INTO message (guid, text, handle_id, service, date, is_from_me)
               VALUES (?,?,?,?,?,?)""",
            (f"T-{i:06d}", text, 0 if from_me else hid, service, to_apple_ns(when), from_me),
        )
        cur.execute(
            "INSERT INTO chat_message_join VALUES (?,?,?)", (cid, cur.lastrowid, to_apple_ns(when))
        )

    con.commit()
    con.close()
    return path


def sent(text: str) -> tuple[str, str, int]:
    return ("", text, 1)


def received(text: str) -> tuple[str, str, int]:
    return ("", text, 0)
