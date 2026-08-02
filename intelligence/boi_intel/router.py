"""Model router — one place that turns `BOI_MODEL_PROVIDER` into a provider.

Every candidate implements the same `complete(system, cached_prefix, suffix)`, so
switching models in 05 is a config change rather than a code change. That is the point:
CONTRACTS.md § 11 item 12 says not to spend a day choosing a model, and the only way
that is true later is if the seam exists now.

**The default is `fake`.** A unit suite that reaches the network fails randomly and the
failures read as flaky tests rather than as a misconfiguration.
"""

from __future__ import annotations

import os

from boi_intel.providers.fake import FakeProvider, ModelProvider
from boi_intel.providers.gemini import GeminiProvider
from boi_intel.providers.kimi import KimiProvider

DEFAULT_PROVIDER = "fake"
PROVIDER_ENV_VAR = "BOI_MODEL_PROVIDER"

_BUILDERS = {
    "fake": FakeProvider,
    "gemini": GeminiProvider,
    "kimi": KimiProvider,
}


class UnknownProvider(ValueError):
    """A name that is not `fake`, `gemini` or `kimi`.

    Raised rather than silently falling back: a typo in `BOI_MODEL_PROVIDER` that
    quietly yields `FakeProvider` would make an eval run in 05 report recorded
    transcripts as if they were live model output.
    """


def provider_names() -> tuple[str, ...]:
    return tuple(_BUILDERS)


def select_provider(name: str | None = None, **kwargs) -> ModelProvider:
    """Build the provider named by `name`, else `$BOI_MODEL_PROVIDER`, else `fake`."""
    resolved = (name or os.environ.get(PROVIDER_ENV_VAR) or DEFAULT_PROVIDER).strip().lower()
    builder = _BUILDERS.get(resolved)
    if builder is None:
        raise UnknownProvider(
            f"unknown model provider {resolved!r}; expected one of {', '.join(_BUILDERS)}"
        )
    return builder(**kwargs)
