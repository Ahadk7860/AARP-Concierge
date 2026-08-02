"""Foundation-owned fake model provider.

Replays recorded responses so Track B can build the router, validator and eval
harness with no API key and no rate limit. Live providers implement the same
`complete()` signature.

Track B owns `providers/gemini.py` and `providers/kimi.py`; it does not modify this
file.
"""

from __future__ import annotations

import json
import pathlib
from typing import Protocol


class ModelProvider(Protocol):
    model_id: str

    def complete(self, system: str, cached_prefix: str, suffix: str) -> str:
        """Return raw model text.

        `cached_prefix` is the voice pack. It is passed separately from `suffix`
        because it is static per (user, contact, voice_pack_version) for a week and
        belongs in the provider's prompt-cache block. Collapsing these two arguments
        into one string is the single most expensive mistake available here.
        """
        ...


class FakeProvider:
    """Deterministic replay. Keyed on gist_id found in the suffix."""

    model_id = "fake-replay"

    def __init__(self, recordings_dir: str | pathlib.Path | None = None) -> None:
        self.dir = pathlib.Path(
            recordings_dir
            or pathlib.Path(__file__).resolve().parents[3] / "contracts" / "transcripts" / "model"
        )

    def complete(self, system: str, cached_prefix: str, suffix: str) -> str:
        for path in sorted(self.dir.glob("*.json")):
            rec = json.loads(path.read_text())
            if rec["match"]["gist_id_contains"] in suffix:
                return rec["response"]
        raise LookupError(f"no recorded response matches this prompt; add one under {self.dir}")
