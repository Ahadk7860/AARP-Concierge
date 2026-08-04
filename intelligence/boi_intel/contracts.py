"""Foundation-owned. Python mirror of contracts/schema/*.json.

No track modifies this file. A mismatch between these dataclasses and the JSON Schema
is a contract gap: record it in NOTES.md and report. Do not "fix" it locally.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

Stance = Literal["answer", "defer"]
Producer = Literal["sql", "local_model"]


@dataclass(frozen=True)
class Register:
    median_len_chars: int
    emoji_rate: float
    punctuation: str
    avg_msgs_per_burst: float
    p90_len_chars: int | None = None
    top_emoji: list[str] = field(default_factory=list)
    greeting_rate: float = 0.0
    signoff_rate: float = 0.0
    abbreviations: list[str] = field(default_factory=list)
    question_rate: float = 0.0
    apology_openers: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class VoicePack:
    """THE USER'S OWN SENT MESSAGES ONLY.

    Every exemplar must originate from a `message` row where `is_from_me = 1`.
    One inbound message here makes every privacy claim in BOI_ARCHITECTURE.md section 6
    false, and nobody would notice for months. This is asserted three times: at the
    SQL query, at this boundary, and in a test that fails the build.
    """

    schema_version: Literal["voice_pack.v1"]
    voice_pack_version: str
    contact_id: str | None
    scope: Literal["contact", "global"]
    register: Register
    exemplars: list[str]
    as_of: str
    n_exemplars: int = 0


@dataclass(frozen=True)
class GistFacts:
    """The fabrication-gate allowlist.

    A draft may reference a specific date, time, place, amount or name ONLY if it
    appears in one of these lists. Anything else is an invented commitment sent in the
    user's own name, which is worse than shipping no draft at all.
    """

    dates: list[str] = field(default_factory=list)
    times: list[str] = field(default_factory=list)
    places: list[str] = field(default_factory=list)
    amounts: list[str] = field(default_factory=list)
    names: list[str] = field(default_factory=list)

    def all_values(self) -> list[str]:
        return [*self.dates, *self.times, *self.places, *self.amounts, *self.names]


@dataclass(frozen=True)
class Gist:
    schema_version: Literal["gist.v1"]
    gist_id: str
    contact_id: str
    state: str
    days_silent: int
    unanswered_question: bool
    gist: str
    facts: GistFacts
    priority: float
    producer: Producer
    as_of: str
    display: str | None = None
    topic: str | None = None
    has_deadline: bool = False
    deadline_hint: str | None = None
    model_id: str | None = None


@dataclass(frozen=True)
class Candidate:
    stance: Stance
    text: str
    chars: int


@dataclass(frozen=True)
class ValidatorResult:
    passed: bool
    attempts: int
    failures: list[str]


@dataclass(frozen=True)
class DraftBundle:
    """Exactly two candidates, or exactly zero. Never one, never three."""

    schema_version: Literal["draft_bundle.v1"]
    contact_id: str
    gist_id: str
    candidates: list[Candidate]
    model_id: str
    prompt_version: str
    voice_pack_version: str
    validator: ValidatorResult
    as_of: str
    latency_ms: int | None = None

    def __post_init__(self) -> None:
        if len(self.candidates) not in (0, 2):
            raise ValueError(
                f"draft bundles carry exactly 2 candidates or 0, got {len(self.candidates)}"
            )
        if len(self.candidates) == 2 and self.candidates[0].stance == self.candidates[1].stance:
            raise ValueError("the two candidates must differ in stance, not merely in phrasing")

    def to_dict(self) -> dict:
        return asdict(self)


VALIDATOR_FAILURES = (
    "length_gate",
    "register_gate",
    "fabrication_gate",
    "forbidden_phrase",
    "stance_collision",
    "empty",
    # Widened in prompt 06, and a widening only: every value above still means what it
    # meant. A draft that says "sorry, been 3 days" over a four-day-old digest is making
    # a claim licensed by data that has expired -- not the same defect as naming a
    # specific the gist never carried, and a failure list that calls both
    # `fabrication_gate` has lost the thing it exists to carry.
    "stale_tense_gate",
)

# Assistant-speak in a text to your college roommate is worse than no draft at all.
# Track B extends this list; it never shortens it.
FORBIDDEN_PHRASES = (
    "i hope this finds you well",
    "just circling back",
    "reaching out",
    "apologies for the delay",
    "touching base",
    "at your earliest convenience",
    "please let me know if",
    "best,",
    "warm regards",
    "\u2014",  # em dash
)
