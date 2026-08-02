"""Kimi adapter, over the OpenAI-compatible chat-completions shape.

**The key is not provisioned** (CONTRACTS.md § 7), so this has never made a live call
and `FakeProvider` stands in everywhere. It exists now, rather than in 05, so the model
bake-off is a config change instead of a new integration written under time pressure.

`httpx` is already in the base manifest, so this adds no dependency.
"""

from __future__ import annotations

import json

from boi_intel import env
from boi_intel.providers.gemini import LiveCallsDisabled

DEFAULT_MODEL = "kimi-k2.5"
DEFAULT_BASE_URL = "https://api.moonshot.ai/v1"


class KimiProvider:
    """Implements `ModelProvider`. Constructing one is free and makes no call."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
        allow_live: bool | None = None,
    ) -> None:
        self.model_id = model or env.get("KIMI_MODEL") or DEFAULT_MODEL
        self._api_key = api_key if api_key is not None else env.get("KIMI_API_KEY", "")
        self._base_url = base_url or env.get("KIMI_BASE_URL") or DEFAULT_BASE_URL
        self._allow_live = (
            allow_live if allow_live is not None else env.get("BOI_ALLOW_LIVE_CALLS", "0") == "1"
        )

    def preflight(self) -> None:
        if not self._allow_live:
            raise LiveCallsDisabled(
                "BOI_ALLOW_LIVE_CALLS is not 1. Live calls belong in the eval harness, "
                "never in the unit suite (CONTRACTS.md section 9)."
            )
        if not self._api_key:
            raise LiveCallsDisabled(
                "KIMI_API_KEY is empty. CONTRACTS.md section 7 records this key as "
                "not provisioned; use FakeProvider."
            )

    def complete(self, system: str, cached_prefix: str, suffix: str) -> str:
        self.preflight()
        import httpx

        # Prefix and suffix stay separate messages. On an OpenAI-shaped API the cache
        # boundary is a message boundary, so concatenating them here would throw away
        # the reuse the whole split exists to buy.
        payload = {
            "model": self.model_id,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": cached_prefix},
                {"role": "user", "content": suffix},
            ],
            "temperature": 0.9,
            "max_tokens": 400,
            "response_format": {"type": "json_object"},
        }
        response = httpx.post(
            f"{self._base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            content=json.dumps(payload),
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"] or ""
