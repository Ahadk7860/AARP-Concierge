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
import math
import os
import pathlib
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime

from boi_intel import chatdb
from boi_intel import env as env_module
from boi_intel.redact import redact
from boi_intel.register import compute_register

SCHEMA_VERSION = "voice_pack.v1"
MAX_EXEMPLARS = 40
MAX_EXEMPLAR_CHARS = 200
MIN_SENT_FOR_CONTACT_PACK = 5
GLOBAL_FALLBACK_FILENAME = "global_fallback.json"

# Tracks A and B must derive the SAME contact_id for the same handle, or every
# integration diff is noise. CONTRACTS.md section 7 fixes one dev salt for both, in
# `.env`. The real salt arrives from POST /v1/pair and is never this value — so there
# is deliberately no hardcoded fallback here: an unset variable raises.
SALT_ENV_VAR = "BOI_DEV_USER_SALT"

_WS = re.compile(r"\s+")


@dataclass(frozen=True)
class _Exemplar:
    """A candidate exemplar: already redacted and truncated, with its timestamp kept
    so sampling can still spread across the time range."""

    text: str
    ts_epoch: int


def resolve_salt(explicit: str | None = None) -> bytes:
    """`--salt`, else `$BOI_DEV_USER_SALT`, else the same variable from `.env`.

    No hardcoded default: a silent fallback would let Track A and Track B derive
    different contact ids for the same person and the mismatch would surface as an
    unexplainable `--compare` diff rather than as a missing-configuration error.
    """
    if explicit:
        return explicit.encode("utf-8")
    value = os.environ.get(SALT_ENV_VAR) or _from_dotenv(SALT_ENV_VAR)
    if not value:
        raise RuntimeError(
            f"{SALT_ENV_VAR} is not set. Copy .env.example to .env inside this "
            f"worktree, or pass --salt. CONTRACTS.md section 7 fixes one dev salt "
            f"shared by Tracks A and B so contact ids agree."
        )
    return value.encode("utf-8")


def _from_dotenv(key: str) -> str | None:
    """Kept as a named seam because tests patch it; the logic lives in `env`."""
    return env_module.from_dotenv(key)


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


def _select_exemplars(candidates: list[_Exemplar]) -> list[_Exemplar]:
    """Up to 40, sampled across the time range and across lengths.

    Deduplicated on the **final** string — after redaction and truncation, not before.
    Two different 600-character messages that share their first 200 characters truncate
    to the same exemplar, and two different phone numbers both redact to `[phone]`; a
    dedup that runs on the raw text calls those distinct and ships the same string
    twenty times inside a nominally-40-exemplar pack.
    """
    seen: set[str] = set()
    unique: list[_Exemplar] = []
    for m in candidates:
        key = _norm(m.text)
        if key and key not in seen:
            seen.add(key)
            unique.append(m)

    if len(unique) <= MAX_EXEMPLARS:
        return unique

    n_buckets = min(MAX_EXEMPLARS, 8)
    size = len(unique) / n_buckets
    buckets: list[list[_Exemplar]] = []
    for b in range(n_buckets):
        lo, hi = math.floor(b * size), math.floor((b + 1) * size)
        buckets.append(unique[lo:hi])

    # Within each time bucket, walk the length distribution rather than the clock.
    orders = []
    for bucket in buckets:
        by_len = sorted(bucket, key=lambda m: (len(m.text), m.ts_epoch, m.text))
        orders.append([by_len[i] for i in _spread_order(len(by_len))])

    picked: list[_Exemplar] = []
    depth = 0
    while len(picked) < MAX_EXEMPLARS and any(depth < len(o) for o in orders):
        for order in orders:
            if depth < len(order):
                picked.append(order[depth])
                if len(picked) == MAX_EXEMPLARS:
                    break
        depth += 1

    return sorted(picked, key=lambda m: (m.ts_epoch, m.text))


def _content_hash(contact_id: str | None, scope: str, register: dict, exemplars: list[str]) -> str:
    """Deterministic content hash, exactly as pinned by CONTRACTS.md section 6:
    `"vp_" + sha256(canonical_json)[:8]`.

    The payload is `{contact_id, scope, register, exemplars}` with sorted keys and no
    whitespace. Two properties are contractual, not stylistic:

    - **`as_of` is excluded.** Two builds of an unchanged corpus must produce the same
      version, or the drafter's prompt cache is invalidated every morning for nothing.
    - **`ensure_ascii=False`.** Emoji in `top_emoji` are hashed as the characters
      themselves, never as `\\uXXXX` escapes. Swift has no `ensure_ascii=True`
      equivalent, so escaping here would guarantee a mismatch with Track A's port.
    """
    payload = json.dumps(
        {"contact_id": contact_id, "scope": scope, "register": register, "exemplars": exemplars},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return "vp_" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:8]


def _serialize(
    messages: list[chatdb.SentMessage], contact_id: str | None, scope: str, as_of: str
) -> dict:
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

    # The register comes off the RAW corpus, before a single character is redacted.
    # CONTRACTS.md sections 6 and 7 require this order and explain the failure it
    # prevents: redacting first turns "Hey Sarah how are you" into "[name] how are
    # you", which stops counting as a greeting and flips the leading character to
    # lowercase, so a sentence-case writer is reported as `lowercase_no_period` with a
    # third of their true greeting rate — while every register test still passes.
    register = compute_register(
        [m.text for m in messages],
        [m.ts_epoch for m in messages],
    )

    # Redaction applies to the exemplars alone, and the pipeline order matters:
    # redact -> truncate -> dedup -> sample. Dedup must see the final string, or
    # forty exemplars can be twenty-one unique ones (see `_select_exemplars`).
    candidates = [_Exemplar(text=_truncate(redact(m.text)), ts_epoch=m.ts_epoch) for m in messages]
    candidates = [c for c in candidates if c.text.strip()]
    exemplars = [c.text for c in _select_exemplars(candidates)]

    if len(exemplars) > MAX_EXEMPLARS:
        raise ValueError(f"{len(exemplars)} exemplars exceeds the cap of {MAX_EXEMPLARS}")
    for e in exemplars:
        if len(e) > MAX_EXEMPLAR_CHARS:
            raise ValueError(f"exemplar of {len(e)} chars exceeds the cap of {MAX_EXEMPLAR_CHARS}")

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


def build_packs(
    db_path: str, salt: bytes | None = None, as_of: str | None = None
) -> dict[str, dict]:
    """Every per-contact pack plus the global fallback, keyed by output filename.

    `salt` defaults to `$BOI_DEV_USER_SALT` (see `resolve_salt`), which Track A uses
    too, so both implementations derive identical contact ids from the same handle.
    """
    salt = salt if salt is not None else resolve_salt()
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
    ap.add_argument(
        "--compare",
        nargs="+",
        metavar="PACK",
        help="diff two packs field by field. Give two paths, or one path together with --pack.",
    )
    ap.add_argument(
        "--ignore",
        nargs="*",
        default=[],
        metavar="FIELD",
        help="top-level fields to skip when comparing, e.g. as_of",
    )
    ap.add_argument(
        "--salt", default=None, help=f"user_salt for the contact_id HMAC; ${SALT_ENV_VAR} otherwise"
    )
    ap.add_argument(
        "--as-of", dest="as_of", default=None, help="ISO 8601 UTC timestamp to stamp on every pack"
    )
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

    packs = build_packs(a.db, salt=resolve_salt(a.salt), as_of=a.as_of)
    for path in write_packs(packs, a.out):
        pack = packs[path.name]
        print(
            f"{path}  {pack['voice_pack_version']}  "
            f"{pack['scope']}  {pack['n_exemplars']} exemplars"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
