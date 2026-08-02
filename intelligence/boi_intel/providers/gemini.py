"""Gemini adapter. Track B is the only track permitted live calls (CONTRACTS.md § 9).

Two independent switches must both be on before a byte leaves the machine:
`BOI_MODEL_PROVIDER=gemini` **and** `BOI_ALLOW_LIVE_CALLS=1`, plus a key. One switch
would be an accident waiting to happen — a unit suite that quietly acquires a network
dependency fails randomly, at a third of the throughput, and reads as flaky rather than
as misconfigured.

The `cached_prefix` / `suffix` split is preserved into the request rather than being
concatenated at the boundary, because the prefix is the expensive, static part.
"""

from __future__ import annotations

from boi_intel import env

DEFAULT_MODEL = "gemini-2.5-flash-lite"


class LiveCallsDisabled(RuntimeError):
    """Raised instead of making a network call. Never caught silently."""


class GeminiProvider:
    """Implements `ModelProvider`. Constructing one is free and makes no call."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        allow_live: bool | None = None,
    ) -> None:
        self.model_id = model or env.get("GEMINI_MODEL") or DEFAULT_MODEL
        self._api_key = api_key if api_key is not None else env.get("GEMINI_API_KEY", "")
        self._allow_live = (
            allow_live if allow_live is not None else env.get("BOI_ALLOW_LIVE_CALLS", "0") == "1"
        )
        self._client = None
        # Populated after each call so the eval harness can report MEASURED tokens
        # rather than an estimate. Additive: `ModelProvider` is frozen and only
        # requires `complete()`, so nothing else needs to know this exists.
        self.last_usage: dict | None = None

    def preflight(self) -> None:
        """Everything that must be true before a request. Separated so the eval harness
        in 05 can check a whole matrix of models without sending anything."""
        if not self._allow_live:
            raise LiveCallsDisabled(
                "BOI_ALLOW_LIVE_CALLS is not 1. Live calls belong in the eval harness, "
                "never in the unit suite (CONTRACTS.md section 9)."
            )
        if not self._api_key:
            raise LiveCallsDisabled(
                "GEMINI_API_KEY is empty. The user acquires this key (CONTRACTS.md section 7)."
            )

    def _get_client(self):
        if self._client is None:
            try:
                from google import genai
            except ImportError as exc:  # pragma: no cover - depends on the extra
                raise LiveCallsDisabled(
                    "google-genai is not installed; pip install -e '.[live]'"
                ) from exc
            self._client = genai.Client(api_key=self._api_key)
        return self._client

    def complete(self, system: str, cached_prefix: str, suffix: str) -> str:
        self.preflight()
        client = self._get_client()
        from google.genai import types

        # The prefix is sent as its own leading content part, which is what Gemini's
        # implicit context caching keys on. Explicit `caches.create` is the upgrade
        # path once there is a real (user, contact, voice_pack_version) TTL to manage;
        # the argument split here is what makes that a config change, not a rewrite.
        response = client.models.generate_content(
            model=self.model_id,
            contents=[cached_prefix, suffix],
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=0.9,
                max_output_tokens=400,
                response_mime_type="application/json",
            ),
        )
        usage = getattr(response, "usage_metadata", None)
        self.last_usage = (
            {
                "input_tokens": getattr(usage, "prompt_token_count", None) or 0,
                "output_tokens": getattr(usage, "candidates_token_count", None) or 0,
                "cached_tokens": getattr(usage, "cached_content_token_count", None) or 0,
            }
            if usage is not None
            else None
        )
        return response.text or ""
