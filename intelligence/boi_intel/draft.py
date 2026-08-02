"""The drafter — two candidates that differ in stance.

    python -m boi_intel.draft \\
        --voice-pack contracts/fixtures/voice_pack/maya.json \\
        --gist contracts/fixtures/gist/maya_action_needed.json

The design rests on the asymmetry the whole track exists to hold: **the voice we imitate
is the user's own, the content we must understand is somebody else's.** The voice pack
is the user's own sent messages and goes in the cached prefix; the gist is an
abstraction of the other person and goes in the suffix. Neither the corpus nor a
sentence of the other person's prose is ever in the prompt.

**Exactly two candidates, or exactly zero.** The frozen `DraftBundle` raises on one, on
three, and on two that share a stance. Zero is a legitimate degraded outcome; a bad
draft is a trust event.

This prompt does not own the semantic gates — prompt 04 does. What ships here is the
structural validation the drafter cannot avoid doing anyway (did the model return two
usable, stance-distinct, non-empty, in-bounds candidates?), expressed in the frozen
`VALIDATOR_FAILURES` vocabulary so 04 extends it rather than replacing it.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time
from datetime import UTC, datetime

from boi_intel.contracts import Candidate, DraftBundle, ValidatorResult
from boi_intel.prompts import (
    PROMPT_VERSION_DEFAULT,
    SYSTEM,
    cache_key,
    parse_candidates,
    prompt_hash,
    render_gist,
    render_voice_pack,
)
from boi_intel.router import select_provider

SCHEMA_VERSION = "draft_bundle.v1"

# `draft_bundle.v1.candidates.items.text` maxLength. A message past this is not a text
# message, whatever else it is.
MAX_CANDIDATE_CHARS = 400

# The schema caps `validator.attempts` at 2: one try, one retry, then degrade.
MAX_ATTEMPTS = 2

DEFAULT_USER_ID = "usr_local_dev"


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def structural_failures(candidates: list[dict]) -> list[str]:
    """Gates the drafter cannot avoid, in the frozen `VALIDATOR_FAILURES` vocabulary.

    Deliberately NOT the register, fabrication or forbidden-phrase gates — those are
    prompt 04's, and inventing a half-version of them here would mean two
    implementations disagreeing about what "passed" means.
    """
    failures: list[str] = []
    if len(candidates) != 2:
        failures.append("empty")
        return failures
    if any(not c["text"].strip() for c in candidates):
        failures.append("empty")
    if any(len(c["text"]) > MAX_CANDIDATE_CHARS for c in candidates):
        failures.append("length_gate")
    if candidates[0]["stance"] == candidates[1]["stance"]:
        failures.append("stance_collision")
    return failures


def _log(event: str, **fields) -> None:
    """Structured JSON to stdout, per CONTRACTS.md § 6.

    Every field here is an identifier or a hash. The prompt, the exemplars, the gist
    text and the candidate text are all absent by construction — a bad draft is
    reproducible from `(voice_pack_version, gist_id, prompt_version, model_id)` plus
    the prompt hash, and none of that is somebody's messages.
    """
    print(json.dumps({"event": event, **fields}, sort_keys=True))


def draft(
    voice_pack: dict,
    gist: dict,
    provider=None,
    user_id: str = DEFAULT_USER_ID,
    prompt_version: str | None = None,
    as_of: str | None = None,
    validate=None,
) -> DraftBundle:
    """Two stance-distinct candidates for one gist, or zero.

    `validate` is the seam prompt 04 fills: a callable taking the candidate dicts and
    the gist and returning a list of failure slugs. Left `None`, only the structural
    gates run.
    """
    provider = provider if provider is not None else select_provider()
    prompt_version = (
        prompt_version or os.environ.get("BOI_PROMPT_VERSION") or PROMPT_VERSION_DEFAULT
    )
    as_of = as_of or _now_iso()

    cached_prefix = render_voice_pack(voice_pack)
    suffix = render_gist(gist)
    key = cache_key(user_id, gist["contact_id"], voice_pack["voice_pack_version"])
    phash = prompt_hash(SYSTEM, cached_prefix, suffix)

    started = time.monotonic()
    candidates: list[dict] = []
    failures: list[str] = []
    attempts = 0

    while attempts < MAX_ATTEMPTS:
        attempts += 1
        raw = provider.complete(SYSTEM, cached_prefix, suffix)
        candidates = parse_candidates(raw)
        failures = structural_failures(candidates)
        if not failures and validate is not None:
            failures = list(validate(candidates, gist, voice_pack))
        if not failures:
            break

    latency_ms = int((time.monotonic() - started) * 1000)
    passed = not failures

    _log(
        "draft.produced",
        cache_key=key,
        prompt_hash=phash,
        prompt_version=prompt_version,
        model_id=provider.model_id,
        voice_pack_version=voice_pack["voice_pack_version"],
        gist_id=gist["gist_id"],
        contact_id=gist["contact_id"],
        attempts=attempts,
        passed=passed,
        failures=failures,
        latency_ms=latency_ms,
    )

    return DraftBundle(
        schema_version=SCHEMA_VERSION,
        contact_id=gist["contact_id"],
        gist_id=gist["gist_id"],
        # Degrade to zero rather than shipping what failed. A brief with no draft is
        # fine; a brief with a bad draft is a trust event.
        candidates=(
            [
                Candidate(stance=c["stance"], text=c["text"], chars=len(c["text"]))
                for c in candidates
            ]
            if passed
            else []
        ),
        model_id=provider.model_id,
        prompt_version=prompt_version,
        voice_pack_version=voice_pack["voice_pack_version"],
        validator=ValidatorResult(passed=passed, attempts=attempts, failures=failures),
        as_of=as_of,
        latency_ms=latency_ms,
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m boi_intel.draft",
        description="Draft two stance-distinct candidates from a voice pack and a gist.",
    )
    ap.add_argument("--voice-pack", required=True, help="path to a voice_pack.v1 document")
    ap.add_argument("--gist", required=True, help="path to a gist.v1 document")
    ap.add_argument("--out", default=None, help="write the bundle here as well as printing it")
    ap.add_argument("--provider", default=None, help="fake | gemini | kimi")
    ap.add_argument("--user-id", dest="user_id", default=DEFAULT_USER_ID)
    ap.add_argument("--as-of", dest="as_of", default=None)
    a = ap.parse_args(argv)

    voice_pack = json.loads(pathlib.Path(a.voice_pack).read_text())
    gist = json.loads(pathlib.Path(a.gist).read_text())

    bundle = draft(
        voice_pack,
        gist,
        provider=select_provider(a.provider),
        user_id=a.user_id,
        as_of=a.as_of,
    )
    payload = bundle.to_dict()

    if a.out:
        out = pathlib.Path(a.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")

    print(json.dumps(payload, indent=2, ensure_ascii=False))
    for c in payload["candidates"]:
        print(f"\n[{c['stance']}] ({c['chars']} chars)\n  {c['text']}", file=sys.stderr)
    if not payload["candidates"]:
        print(
            f"\nno candidates — degraded after {payload['validator']['attempts']} "
            f"attempt(s): {', '.join(payload['validator']['failures'])}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
