"""`gist.v1.facts` — the fabrication-gate allowlist, and the topic label.

This is not decoration. It is the **complete set of specifics a draft is permitted to
name**, and prompt 04's validator rejects any date, time, place, amount or name in a
draft that is not in here. Both directions cost something:

- **Under-populated** and the drafts go vague — the validator refuses a draft that says
  "the 14th" because nobody recorded that the 14th was ever mentioned.
- **Over-populated** and the gate stops gating. Every string added here is a specific
  the drafter may assert in the user's own name.

So each extractor is deliberately narrow and anchored on an explicit pattern. When a
rule is unsure, it does not add the string — a vague gist beats a hallucinated one.

Extraction reads the OTHER person's messages, which is why it runs on the Mac. Only the
extracted tokens travel, never the sentences they came from.
"""

from __future__ import annotations

import re

from boi_intel.redact import COMMON_GIVEN_NAMES

MAX_PER_CATEGORY = 8

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
MONTHS = (
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
)
RELATIVE_DAYS = (
    "today",
    "tomorrow",
    "tonight",
    "this weekend",
    "next weekend",
    "this week",
    "next week",
    "this month",
    "next month",
    "the weekend",
)

_I = re.IGNORECASE
_CS = 0  # case-sensitive: capitalisation IS the signal, so IGNORECASE destroys it

_DATE_PATTERNS = [
    # "the 14th", "the 3rd"
    (r"\bthe[^\S\n]+\d{1,2}(?:st|nd|rd|th)\b", _I),
    # bare ordinal day: "14th"
    (r"\b\d{1,2}(?:st|nd|rd|th)\b", _I),
    # "aug 3", "August 3rd", "3 aug"
    (rf"\b(?:{'|'.join(MONTHS)})\.?[^\S\n]+\d{{1,2}}(?:st|nd|rd|th)?\b", _I),
    (rf"\b\d{{1,2}}[^\S\n]+(?:{'|'.join(MONTHS)})\.?\b", _I),
    # 8/14, 8-14-2026
    (r"\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b", _I),
    # weekdays, with an optional qualifier
    (rf"\b(?:next[^\S\n]+|this[^\S\n]+|last[^\S\n]+)?(?:{'|'.join(WEEKDAYS)})\b", _I),
    (rf"\b(?:{'|'.join(RELATIVE_DAYS)})\b", _I),
]

_TIME_PATTERNS = [
    (r"\b\d{1,2}:\d{2}[^\S\n]*(?:am|pm)?\b", _I),
    (r"\b\d{1,2}[^\S\n]*(?:am|pm)\b", _I),
    (r"\b(?:noon|midnight)\b", _I),
    # Capture the clock reading only: "at 3pm" is anchored on "at", but the fact the
    # drafter may name is "3pm".
    (r"\bat[^\S\n]+(\d{1,2}(?:[^\S\n]*(?:am|pm))?)\b", _I),
]

# Money, reused from the redactor's vocabulary but EXTRACTING rather than replacing.
_AMOUNT_PATTERNS = [
    (r"[$£€][^\S\n]?\d[\d,]*(?:\.\d{1,2})?", _I),
    (r"\b\d[\d,]*(?:\.\d{1,2})?[^\S\n]?(?:dollars?|bucks|usd|euros?|quid)\b", _I),
]

# A place is anchored on a preposition, because an unanchored capitalised word is more
# often a brand, a product, or a sentence opener than it is somewhere you can go.
# `[^\S\n]` is "whitespace but not a newline" — plain `\s` would let a match run off the
# end of one message and into the next, splicing two people's sentences into one "fact".
_PLACE_PATTERNS = [
    (
        r"\b(?:at|in|to|near|by)[^\S\n]+(?:the[^\S\n]+)?"
        r"([A-Z][\w'&-]+(?:[^\S\n]+[A-Z][\w'&-]+){0,3})\b",
        _CS,
    ),
    (
        r"\b(?:at|in|to)[^\S\n]+(the[^\S\n]+(?:office|airport|station|gym|park|bar"
        r"|restaurant|hotel|library|museum|beach|house|apartment|hospital|studio|cafe"
        r"|coffee[^\S\n]+shop))\b",
        _I,
    ),
    (r"\b((?:your|my|their|his|her)[^\S\n]+(?:place|house|apartment|office))\b", _I),
]

_NAME_PATTERNS = [
    # Capitalised full name. Case-sensitive on purpose — under IGNORECASE this pattern
    # degrades into "any two to four words" and starts harvesting whole sentences.
    (r"\b[A-Z][a-z]{1,20}(?:[^\S\n]+[A-Z][a-z]{1,20}){1,3}\b", _CS),
]

# A fact is a token, not a clause. Anything longer is a prose span that slipped through
# a pattern, and prose spans are exactly what must not cross the boundary.
MAX_FACT_WORDS = 5

# Words that pass the ordinal/weekday shapes but are not dates in context.
_DATE_STOPWORDS = frozenset({"may"})


def _findall(patterns: list[tuple[str, int]], messages: list[str]) -> list[str]:
    """Scan each message separately, never a joined blob.

    Scanning a blob lets a pattern match across the seam between two messages and emit
    "all\\nlmk what you" as a place name — a splice of two sentences nobody wrote,
    carried into a document that crosses the boundary to the cloud.
    """
    out: list[str] = []
    for message in messages:
        if not message:
            continue
        for pattern, flags in patterns:
            for m in re.finditer(pattern, message, flags):
                # A capturing group means the pattern anchors on context it should not keep.
                value = m.group(1) if m.groups() else m.group(0)
                value = value.strip().strip(".,;:!?")
                if _is_a_token(value):
                    out.append(value)
    return out


def _is_a_token(value: str) -> bool:
    return bool(value) and "\n" not in value and len(value.split()) <= MAX_FACT_WORDS


def _dedupe_preserving_order(values: list[str], limit: int, max_len: int) -> list[str]:
    """Case-insensitive dedupe, capped, with redundant substrings suppressed.

    Both rules keep the allowlist tight, and tightness is the point — every extra
    string is one more specific the drafter may assert in the user's own name.

    Substring suppression matters more than it looks: `"the 14th"` and `"14th"` are one
    date wearing two hats, and keeping both spends two of the eight slots on one fact
    while making the gate look broader than it is. The longer, more specific spelling
    wins; the bare one is dropped only when it is contained in a kept value.
    """
    kept: list[str] = []
    seen: set[str] = set()
    for v in values:
        v = v.strip()
        if not v or len(v) > max_len:
            continue
        key = v.lower()
        if key not in seen:
            seen.add(key)
            kept.append(v)

    # Longest first, so the specific spelling is the one that survives.
    by_specificity = sorted(kept, key=lambda s: (-len(s), s.lower()))
    survivors: list[str] = []
    for v in by_specificity:
        low = v.lower()
        if any(low in s.lower() and low != s.lower() for s in survivors):
            continue
        survivors.append(v)

    ordered = [v for v in kept if v in survivors]
    return ordered[:limit]


def _lowercase_names(messages: list[str]) -> list[str]:
    """Lowercase "john smith" — the same blind spot the voice pack had. The target
    corpus is lowercase texting, so a capitalised-only name rule finds nothing."""
    from boi_intel.redact import _NOT_A_SURNAME

    out = []
    for message in messages:
        if not message:
            continue
        for m in re.finditer(r"\b([a-z][a-z'-]{1,20})[^\S\n]+([a-z][a-z'-]{1,20})\b", message):
            first, second = m.group(1), m.group(2)
            if first in COMMON_GIVEN_NAMES and second not in _NOT_A_SURNAME:
                out.append(m.group(0))
    return out


def extract_facts(messages: list[str]) -> dict[str, list[str]]:
    """The allowlist, from the other person's recent messages.

    Always returns all five keys, so `gist.v1.facts` is structurally complete even when
    a thread mentions nothing specific at all — five empty lists is a valid, and common,
    answer.
    """
    messages = [m for m in messages if m]

    dates = [d for d in _findall(_DATE_PATTERNS, messages) if d.lower() not in _DATE_STOPWORDS]
    times = _findall(_TIME_PATTERNS, messages)
    places = _findall(_PLACE_PATTERNS, messages)
    amounts = _findall(_AMOUNT_PATTERNS, messages)
    names = _findall(_NAME_PATTERNS, messages) + _lowercase_names(messages)

    resolved_places = _dedupe_preserving_order(places, MAX_PER_CATEGORY, 60)
    # A capitalised venue matches the full-name pattern too. Listing "Ferry Building"
    # as both a place and a person is not harmful — the allowlist permits the same
    # string either way — but it spends two slots on one referent and misreports what
    # the gate actually covers.
    place_keys = {p.lower() for p in resolved_places}
    names = [n for n in names if n.lower() not in place_keys]

    return {
        "dates": _dedupe_preserving_order(dates, MAX_PER_CATEGORY, 40),
        "times": _dedupe_preserving_order(times, MAX_PER_CATEGORY, 40),
        "places": resolved_places,
        "amounts": _dedupe_preserving_order(amounts, MAX_PER_CATEGORY, 30),
        "names": _dedupe_preserving_order(names, MAX_PER_CATEGORY, 60),
    }


# Topic is a CATEGORY LABEL, never a quotation (gist.v1: `topic` maxLength 40).
_TOPIC_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "travel_planning",
        (
            "flight",
            "flights",
            "book",
            "booking",
            "trip",
            "hotel",
            "airbnb",
            "airport",
            "visit",
            "coming to",
            "fly",
            "train",
        ),
    ),
    (
        "scheduling",
        (
            "free",
            "meet",
            "dinner",
            "lunch",
            "coffee",
            "brunch",
            "hang",
            "calendar",
            "reschedule",
            "time works",
            "still on",
        ),
    ),
    ("money", ("venmo", "owe", "split", "pay", "paid", "invoice", "reimburse", "cost")),
    (
        "work",
        (
            "meeting",
            "deck",
            "project",
            "deadline",
            "client",
            "standup",
            "review",
            "interview",
            "resume",
            "offer",
        ),
    ),
    (
        "family",
        (
            "mom",
            "dad",
            "grandma",
            "grandpa",
            "aunt",
            "uncle",
            "cousin",
            "birthday",
            "wedding",
            "funeral",
            "holidays",
        ),
    ),
    (
        "check_in",
        (
            "how are you",
            "how have you been",
            "miss you",
            "thinking of you",
            "long time",
            "catch up",
        ),
    ),
)


def infer_topic(messages: list[str]) -> str | None:
    """A category label from a closed vocabulary, or `None`.

    Closed on purpose: anything derived from the text itself risks being a quotation,
    and `topic` crosses the boundary into the cloud.
    """
    blob = "\n".join(m for m in messages if m).lower()
    if not blob.strip():
        return None
    best: tuple[int, str] | None = None
    for label, keywords in _TOPIC_KEYWORDS:
        score = sum(blob.count(k) for k in keywords)
        if score and (best is None or score > best[0]):
            best = (score, label)
    return best[1] if best else None
