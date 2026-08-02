"""The voice-pack builder — and the oracle for Track A's Swift port.

    python -m boi_intel.voice --db /tmp/boi-b/chat.db --out /tmp/boi-b/out/
    python -m boi_intel.voice --compare a.json b.json

A voice pack carries the user's **own sent messages only**, redacted. It is the reason
drafting does not break the digest boundary: the voice we imitate is the user's, the
content we must understand is somebody else's, and those separate cleanly.

`is_from_me = 1` is asserted twice inside this process — once in the SQL
(`chatdb._SENT_PREDICATE`) and once again at `_serialize`, over the very rows the query
returned. The two are deliberately independent: a query rewritten by someone who does
not know why the predicate is there still hits the serializer. The third guard lives
outside this process, in `scripts/check_voice_pack_leak.py`. CONTRACTS.md section 7
requires all three, and none of them may be weakened to make a checklist green.

Nothing in this module calls a model. Exemplar selection is stratified sampling, which
is deterministic, free, and — unlike a model — reproducible by a Swift port.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys
from datetime import UTC, datetime

from boi_intel import chatdb
from boi_intel.redact import redact
from boi_intel.register import compute_register

SCHEMA_VERSION = "voice_pack.v1"
MAX_EXEMPLARS = 40
MAX_EXEMPLAR_CHARS = 200
MIN_SENT_FOR_CONTACT_PACK = 5
GLOBAL_FALLBACK_FILENAME = "global_fallback.json"

# Development default. The real salt is issued once by POST /v1/pair and lives in the
# macOS Keychain (CONTRACTS.md section 7); it never has a default in production.
DEFAULT_SALT = b"boi-dev-salt"

_WS = re.compile(r"\s+")


class VoicePackLeakError(RuntimeError):
    """Guard two of three fired: a row that is not the user's reached the serializer.

    Raising is the only correct response. A pack that quietly drops the offending
    exemplar would leave the broken query in place and the next build would leak.
    """


def _norm(s: str) -> str:
    return _WS.sub(" ", s or "").strip().lower()


def _truncate(text: str, limit: int = MAX_EXEMPLAR_CHARS) -> str:
    """Trim to the limit on a word boundary. A mid-word cut reads as a typo and would
    show up in the register statistics as one."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    if space >= limit // 2:
        cut = cut[:space]
    return cut.rstrip()


def _spread_order(k: int) -> list[int]:
    """Indices of a length-sorted list, ordered shortest, longest, then by repeated
    bisection. Taking the first `n` of this gives a sample spread across the whole
    length distribution rather than clustered at the median."""
    if k <= 0:
        return []
    out: list[int] = []
    seen: set[int] = set()

    def push(i: int) -> None:
        if 0 <= i < k and i not in seen:
            seen.add(i)
            out.append(i)

    push(0)
    push(k - 1)
    queue = [(0, k - 1)]
    while queue:
        lo, hi = queue.pop(0)
        if lo > hi:
            continue
        mid = (lo + hi) // 2
        push(mid)
        queue.append((lo, mid - 1))
        queue.append((mid + 1, hi))
    return out


def _select_exemplars(candidates: list[chatdb.SentMessage]) -> list[chatdb.SentMessage]:
    """Up to 40, sampled across the time range and across lengths.

    Deduplicated first: a corpus where the user typed "ok" two hundred times would
    otherwise produce forty identical exemplars, which teaches a drafter nothing and
    makes the content hash hypersensitive to a single new message.
    """
    seen: set[str] = set()
    unique: list[chatdb.SentMessage] = []
    for m in candidates:
        key = _norm(m.text)
        if key and key not in seen:
            seen.add(key)
            unique.append(m)

    if len(unique) <= MAX_EXEMPLARS:
        return unique

    n_buckets = min(MAX_EXEMPLARS, 8)
    size = len(unique) / n_buckets
    buckets: list[list[chatdb.SentMessage]] = []
    for b in range(n_buckets):
        lo, hi = int(round(b * size)), int(round((b + 1) * size))
        buckets.append(unique[lo:hi])

    # Within each time bucket, walk the length distribution rather than the clock.
    orders = []
    for bucket in buckets:
        by_len = sorted(bucket, key=lambda m: (len(m.text), m.ts_epoch, m.text))
        orders.append([by_len[i] for i in _spread_order(len(by_len))])

    picked: list[chatdb.SentMessage] = []
    depth = 0
    while len(picked) < MAX_EXEMPLARS and any(depth < len(o) for o in orders):
        for order in orders:
            if depth < len(order):
                picked.append(order[depth])
                if len(picked) == MAX_EXEMPLARS:
                    break
        depth += 1

    return sorted(picked, key=lambda m: (m.ts_epoch, m.text))


def _content_hash(contact_id: str | None, scope: str, register: dict,
                  exemplars: list[str]) -> str:
    """Deterministic content hash, prefixed `vp_`.

    `as_of` is excluded on purpose: two builds of an unchanged corpus must produce the
    same version, or the drafter's prompt cache is invalidated every morning for no
    reason. Changing one exemplar, or one register statistic, changes it.
    """
    payload = json.dumps(
        {"contact_id": contact_id, "scope": scope, "register": register,
         "exemplars": exemplars},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    )
    return "vp_" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def _serialize(messages: list[chatdb.SentMessage], contact_id: str | None,
               scope: str, as_of: str) -> dict:
    """Guard two of three, then the pack.

    Every source row is re-checked here, over the rows the query actually returned.
    """
    for m in messages:
        if m.is_from_me != 1:
            raise VoicePackLeakError(
                "a row with is_from_me="
                f"{m.is_from_me} reached the voice-pack serializer. Every exemplar "
                "must originate from a message the user wrote (CONTRACTS.md section "
                "7). Fix the query; do not filter here."
            )

    selected = _select_exemplars(messages)
    exemplars = [_truncate(redact(m.text)) for m in selected]
    exemplars = [e for e in exemplars if e.strip()]

    if len(exemplars) > MAX_EXEMPLARS:
        raise ValueError(f"{len(exemplars)} exemplars exceeds the cap of {MAX_EXEMPLARS}")
    for e in exemplars:
        if len(e) > MAX_EXEMPLAR_CHARS:
            raise ValueError(
                f"exemplar of {len(e)} chars exceeds the cap of {MAX_EXEMPLAR_CHARS}"
            )

    register = compute_register(
        [redact(m.text) for m in messages],
        [m.ts_epoch for m in messages],
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "voice_pack_version": _content_hash(contact_id, scope, register, exemplars),
        "contact_id": contact_id,
        "scope": scope,
        "n_exemplars": len(exemplars),
        "register": register,
        "exemplars": exemplars,
        "as_of": as_of,
    }


def build_packs(db_path: str, salt: bytes = DEFAULT_SALT,
                as_of: str | None = None) -> dict[str, dict]:
    """Every per-contact pack plus the global fallback, keyed by output filename."""
    as_of = as_of or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    con = chatdb.connect(db_path)
    try:
        by_contact = chatdb.sent_by_contact(con)
        everything = chatdb.all_sent(con)
    finally:
        con.close()

    packs: dict[str, dict] = {}
    for handle in sorted(by_contact):
        messages = by_contact[handle]
        if len(messages) < MIN_SENT_FOR_CONTACT_PACK:
            # Too thin to characterise a register. The global fallback covers them —
            # a wrong voice is worse than a generic one.
            continue
        cid = chatdb.contact_id(handle, salt)
        packs[f"voice_pack_{cid}.json"] = _serialize(messages, cid, "contact", as_of)

    packs[GLOBAL_FALLBACK_FILENAME] = _serialize(everything, None, "global", as_of)
    return packs


def write_packs(packs: dict[str, dict], out_dir: str) -> list[pathlib.Path]:
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for name, pack in packs.items():
        path = out / name
        path.write_text(json.dumps(pack, indent=2, ensure_ascii=False) + "\n")
        written.append(path)
    return written


# --------------------------------------------------------------------------- compare


def diff_packs(a: dict, b: dict, ignore: tuple[str, ...] = ()) -> list[str]:
    """Field-by-field diff, dotted paths, deterministic order.

    This is what Track A's Swift port is verified against at integration: build a pack
    in Swift, build one here from the same database, and this must report nothing.
    """
    out: list[str] = []

    def walk(pa, pb, path: str) -> None:
        if path and path.lstrip(".") in ignore:
            return
        if isinstance(pa, dict) and isinstance(pb, dict):
            for key in sorted(set(pa) | set(pb)):
                child = f"{path}.{key}" if path else key
                if key not in pa:
                    out.append(f"{child}: missing in A, B has {pb[key]!r}")
                elif key not in pb:
                    out.append(f"{child}: A has {pa[key]!r}, missing in B")
                else:
                    walk(pa[key], pb[key], child)
        elif isinstance(pa, list) and isinstance(pb, list):
            if len(pa) != len(pb):
                out.append(f"{path}: length {len(pa)} vs {len(pb)}")
            for i, (ia, ib) in enumerate(zip(pa, pb, strict=False)):
                walk(ia, ib, f"{path}[{i}]")
        elif pa != pb:
            out.append(f"{path}: {pa!r} vs {pb!r}")

    walk(a, b, "")
    return out


def _cmd_compare(paths: list[str], ignore: tuple[str, ...]) -> int:
    a = json.loads(pathlib.Path(paths[0]).read_text())
    b = json.loads(pathlib.Path(paths[1]).read_text())
    diffs = diff_packs(a, b, ignore)
    if not diffs:
        print(f"OK — 0 differences between {paths[0]} and {paths[1]}")
        return 0
    print(f"FAIL — {len(diffs)} difference(s) between {paths[0]} and {paths[1]}\n")
    for d in diffs:
        print("  " + d)
    return 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m boi_intel.voice",
        description="Build voice_pack.v1 documents from a chat.db, or diff two packs.",
    )
    ap.add_argument("--db", help="path to a Messages chat.db, opened read-only")
    ap.add_argument("--out", help="output directory for one pack per contact")
    ap.add_argument("--pack", help="a pack to compare against, used with a single --compare path")
    ap.add_argument("--compare", nargs="+", metavar="PACK",
                    help="diff two packs field by field. Give two paths, or one path "
                         "together with --pack.")
    ap.add_argument("--ignore", nargs="*", default=[], metavar="FIELD",
                    help="top-level fields to skip when comparing, e.g. as_of")
    ap.add_argument("--salt", default=None,
                    help="user_salt for contact_id HMAC; development default otherwise")
    ap.add_argument("--as-of", dest="as_of", default=None,
                    help="ISO 8601 UTC timestamp to stamp on every pack")
    a = ap.parse_args(argv)

    if a.compare:
        paths = list(a.compare)
        if len(paths) == 1 and a.pack:
            paths = [a.pack, paths[0]]
        if len(paths) != 2:
            ap.error("--compare needs two packs: two paths, or one path plus --pack")
        return _cmd_compare(paths, tuple(a.ignore))

    if not a.db or not a.out:
        ap.error("--db and --out are both required unless --compare is given")

    salt = a.salt.encode("utf-8") if a.salt else DEFAULT_SALT
    packs = build_packs(a.db, salt=salt, as_of=a.as_of)
    for path in write_packs(packs, a.out):
        pack = packs[path.name]
        print(f"{path}  {pack['voice_pack_version']}  "
              f"{pack['scope']}  {pack['n_exemplars']} exemplars")
    return 0


if __name__ == "__main__":
    sys.exit(main())
