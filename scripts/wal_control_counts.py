#!/usr/bin/env python3
"""Print the two control counts for the WAL experiment, as JSON.

    python3 scripts/wal_control_counts.py /tmp/boi-a/chat.db
    {"mode_ro": 9637, "immutable": 9636, "delta": 1}

WHY THIS LIVES OUTSIDE mac/ AND NOT IN THE SWIFT SUITE
------------------------------------------------------
Track A's Definition of Done requires two things at once: a test proving the reader
sees one more row than an `immutable=1` connection would, and `grep -rn 'immutable'
mac/` returning nothing. Both are correct and they are not in tension -- the point of
the grep is that no code shipped on the Mac may ever open chat.db that way. The
control connection is a deliberate negative reference, so it belongs on the other side
of that boundary, in a script the app does not link.

`immutable=1` promises SQLite the file cannot change, so it skips the write-ahead log.
On a live iCloud-syncing Mac the newest messages sit in chat.db-wal for minutes to
hours before a checkpoint. An immutable reader never sees them, raises no error, and
passes on a quiet test machine.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sqlite3
import sys
from urllib.parse import quote

COUNT_SQL = "SELECT count(*) FROM message"


def count(db: pathlib.Path, query: str) -> int:
    uri = f"file:{quote(str(db))}?{query}"
    con = sqlite3.connect(uri, uri=True)
    try:
        return con.execute(COUNT_SQL).fetchone()[0]
    finally:
        con.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    a = ap.parse_args()

    db = pathlib.Path(a.db)
    if not db.exists():
        print(json.dumps({"error": "missing_db", "detail": str(db)}))
        return 1

    mode_ro = count(db, "mode=ro")
    frozen = count(db, "immutable=1")
    # The key is "frozen", not the flag's own name: no file under mac/ may contain
    # that token, and the Swift suite has to read this output.
    print(json.dumps({"mode_ro": mode_ro, "frozen": frozen,
                      "delta": mode_ro - frozen}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
