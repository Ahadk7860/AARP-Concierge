"""Configuration lookup: real environment first, then this worktree's `.env`.

Worktrees share neither untracked files nor installed dependencies (CONTRACTS.md § 5),
so `.env` is per-worktree and reading it is the difference between "export four
variables before every command" and "it works".

Deliberately not `python-dotenv`: a dependency is an append to a shared manifest, and
this is twenty lines. Real environment variables always win, so a one-off
`GEMINI_API_KEY=... python -m ...` overrides the file rather than being silently
ignored.
"""

from __future__ import annotations

import os
import pathlib

DOTENV_PATH = pathlib.Path(__file__).resolve().parents[2] / ".env"


def from_dotenv(key: str, path: pathlib.Path | None = None) -> str | None:
    """One key out of `.env`, or `None`. Never raises on a malformed file."""
    path = path or DOTENV_PATH
    if not path.exists():
        return None
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, raw = line.partition("=")
        if name.strip() != key:
            continue
        value = raw.split(" #", 1)[0].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        return value or None
    return None


def get(key: str, default: str = "") -> str:
    """`$KEY`, else `.env`, else `default`."""
    value = os.environ.get(key)
    if value is not None and value != "":
        return value
    return from_dotenv(key) or default
