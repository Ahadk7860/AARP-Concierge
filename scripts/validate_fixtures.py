#!/usr/bin/env python3
"""Validate any JSON document against the frozen contract schemas.

Language-neutral on purpose: a Swift track and a TypeScript track both need to check
their output against the same schema, and neither can run the other's test runner.

    python3 scripts/validate_fixtures.py                       # all committed fixtures
    python3 scripts/validate_fixtures.py digest.v1 out.json    # one document

Exit code 0 means valid. Non-zero prints every violation.
"""
from __future__ import annotations

import json
import pathlib
import sys
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / "contracts" / "schema"
FIXTURE_DIR = ROOT / "contracts" / "fixtures"

try:
    from jsonschema import Draft202012Validator, RefResolver
except ImportError:
    sys.exit("pip install jsonschema  (see pyproject.toml)")


def load(name: str) -> dict:
    p = SCHEMA_DIR / f"{name}.json"
    if not p.exists():
        sys.exit(f"no such schema: {p}")
    return json.loads(p.read_text())


def validator_for(name: str) -> Draft202012Validator:
    schema = load(name)
    store = {}
    for f in SCHEMA_DIR.glob("*.json"):
        s = json.loads(f.read_text())
        store[f.name] = s
        if "$id" in s:
            store[s["$id"]] = s
    resolver = RefResolver(base_uri=SCHEMA_DIR.as_uri() + "/", referrer=schema,
                           store=store)
    return Draft202012Validator(schema, resolver=resolver)


DIR_TO_SCHEMA = {
    "digest": "digest.v1", "voice_pack": "voice_pack.v1", "gist": "gist.v1",
    "draft_bundle": "draft_bundle.v1", "brief": "brief.v1",
    "outbound": "outbound.v1", "inbound": "inbound.v1",
    "digest_v2": "digest.v2", "voice_pack_v2": "voice_pack.v2",
    "chat_query": "chat_query.v1", "chat_reply": "chat_reply.v1",
    "draft_delivery": "draft_delivery.v1",
    "chat_reply_v2": "chat_reply.v2", "chat_route": "chat_route.v1",
}


def check(schema_name: str, path: pathlib.Path) -> list[str]:
    v = validator_for(schema_name)
    doc = json.loads(path.read_text())
    return [f"{path.relative_to(ROOT)}: {e.json_path} — {e.message}"
            for e in sorted(v.iter_errors(doc), key=lambda e: e.path)]


def main() -> None:
    errors: list[str] = []
    if len(sys.argv) == 3:
        errors = check(sys.argv[1], pathlib.Path(sys.argv[2]))
        checked = 1
    else:
        checked = 0
        for sub, schema in DIR_TO_SCHEMA.items():
            for f in sorted((FIXTURE_DIR / sub).glob("*.json")):
                errors += check(schema, f)
                checked += 1
    if errors:
        print(f"FAIL — {len(errors)} violation(s) across {checked} document(s)\n")
        for e in errors:
            print("  " + e)
        sys.exit(1)
    print(f"OK — {checked} document(s) valid against contracts/schema/")


if __name__ == "__main__":
    main()
