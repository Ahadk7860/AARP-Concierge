"""Register statistics — computed, never modelled.

Every number here comes out of arithmetic over the user's own sent messages. No model
sees this stage, which is why it is free, deterministic, and identically reproducible
by Track A's Swift port. The port is verified against this implementation via
`voice --compare`, so a change to any rule here is a change to the oracle.

Shapes conform to `contracts/schema/voice_pack.v1.json` `properties.register`.
"""

from __future__ import annotations

import re
from collections import Counter

# Emoji, by codepoint range. Python's `re` has no \p{Emoji}, and pulling a dependency
# in for one character class is an append to a shared manifest for no benefit.
EMOJI = re.compile(
    "["
    "\U0001f300-\U0001f5ff"  # symbols & pictographs
    "\U0001f600-\U0001f64f"  # emoticons
    "\U0001f680-\U0001f6ff"  # transport & map
    "\U0001f700-\U0001f77f"
    "\U0001f780-\U0001f7ff"
    "\U0001f800-\U0001f8ff"
    "\U0001f900-\U0001f9ff"  # supplemental symbols
    "\U0001fa00-\U0001faff"
    "\U00002600-\U000026ff"  # misc symbols
    "\U00002700-\U000027bf"  # dingbats
    "\U0001f1e6-\U0001f1ff"  # regional indicators
    "\U00002b00-\U00002bff"
    "\U0000fe0f"
    "]"
)

GREETINGS = (
    "hey",
    "hi",
    "hello",
    "yo",
    "sup",
    "morning",
    "gm",
    "howdy",
    "heyy",
    "heyyy",
    "good morning",
    "good afternoon",
    "good evening",
    "whats up",
    "what's up",
)

SIGNOFFS = (
    "thanks",
    "thank you",
    "ty",
    "talk soon",
    "later",
    "ttyl",
    "bye",
    "byee",
    "love you",
    "love u",
    "lyl",
    "xoxo",
    "cheers",
    "see ya",
    "see you",
)

APOLOGY_TOKENS = ("sorry", "sry", "apologies", "my bad", "omg sorry", "so sorry")

# Texting abbreviations worth reporting. A closed list beats inference here: an
# open-ended "short token" heuristic reports typos and proper nouns as style.
ABBREVIATIONS = (
    "lmk",
    "rn",
    "ngl",
    "prob",
    "tmrw",
    "tmr",
    "tbh",
    "idk",
    "imo",
    "btw",
    "omw",
    "brb",
    "np",
    "ty",
    "thx",
    "ur",
    "u",
    "r",
    "pls",
    "plz",
    "cuz",
    "bc",
    "fr",
    "def",
    "obv",
    "def",
    "ig",
    "iirc",
    "afaik",
    "lol",
    "lmao",
    "haha",
    "smh",
    "wyd",
    "hbu",
    "wbu",
    "nvm",
    "ofc",
    "rly",
    "srsly",
    "gonna",
    "wanna",
    "kinda",
    "sorta",
    "gtg",
    "ttyl",
    "ily",
    "yall",
    "y'all",
)

_WORD = re.compile(r"[a-z']+")
BURST_GAP_SECONDS = 300


def _percentile(sorted_vals: list[int], p: int) -> int:
    """Nearest-rank, half-up, exactly as pinned by CONTRACTS.md section 6.

    The index is `ceil(p/100 * n) - 1`, clamped to `[0, n-1]`, with `p` an integer
    percentile. This is pinned because the obvious implementations disagree: Python's
    `round()` is banker's rounding and Swift's `rounded()` is half-away-from-zero, so
    the two produce different `p90_len_chars`, therefore a different
    `voice_pack_version`, therefore a `--compare` diff nobody can explain.

    The ceiling is computed in **integer** arithmetic — `(p * n + 99) // 100` — rather
    than as `ceil(p / 100 * n)`. `p / 100` is not exactly representable in binary
    floating point, so the float form is one unlucky rounding away from stepping to the
    next index, and it would do so in only one of the two languages. Integers have no
    such case. Same rule, no representable-value footnote for Track A to trip over.
    """
    if not sorted_vals:
        return 1
    n = len(sorted_vals)
    idx = (p * n + 99) // 100 - 1
    return sorted_vals[max(0, min(n - 1, idx))]


def _median_int(sorted_vals: list[int]) -> int:
    """The median is p50 under the same nearest-rank rule.

    CONTRACTS.md section 6 pins percentiles but not the median specifically. Defining
    it as p50 rather than as "average the two middle values" means Tracks A and B have
    exactly ONE rounding rule to agree on instead of two.
    """
    return _percentile(sorted_vals, 50)


def _punctuation_class(text: str) -> str | None:
    stripped = text.strip()
    if not stripped:
        return None
    first = next((c for c in stripped if c.isalpha()), None)
    if first is None:
        return None
    case = "lowercase" if first.islower() else "sentence_case"
    period = "period" if stripped.endswith(".") else "no_period"
    return f"{case}_{period}"


def _starts_with(text: str, options: tuple[str, ...]) -> bool:
    low = text.strip().lower()
    return any(
        low == o
        or low.startswith(o + " ")
        or low.startswith(o + ",")
        or low.startswith(o + "!")
        or low.startswith(o + "?")
        or low.startswith(o + ".")
        for o in options
    )


def _ends_with(text: str, options: tuple[str, ...]) -> bool:
    low = text.strip().lower().rstrip(".!?,")
    return any(low == o or low.endswith(" " + o) for o in options)


def _apology_opener(text: str) -> str | None:
    low = text.strip().lower()
    if not _starts_with(low, APOLOGY_TOKENS):
        return None
    words = _WORD.findall(low)[:3]
    return " ".join(words) or None


def _round(x: float, places: int = 4) -> float:
    return round(x + 0.0, places)


def compute_register(texts: list[str], timestamps: list[int] | None = None) -> dict:
    """Register block for a list of RAW, UNREDACTED sent messages.

    **Raw is mandatory, not an optimisation** (CONTRACTS.md sections 6 and 7). Redacting
    first corrupts the very statistics the pack exists to carry: "Hey Sarah how are you"
    becomes "[name] how are you", which stops counting as a greeting and flips the first
    character to lowercase — so a sentence-case writer who opens with a name is reported
    as `lowercase_no_period` with a third of their true `greeting_rate`. Every register
    test still passes and the register is wrong. Redaction applies to `exemplars` only.

    `timestamps` are epoch seconds, aligned with `texts`, and are used only for
    `avg_msgs_per_burst`. Omitting them yields the schema minimum of 1.0 rather than
    a guess.
    """
    texts = [t for t in texts if t and t.strip()]
    if not texts:
        return {
            "median_len_chars": 1,
            "p90_len_chars": 1,
            "emoji_rate": 0.0,
            "top_emoji": [],
            "punctuation": "mixed",
            "greeting_rate": 0.0,
            "signoff_rate": 0.0,
            "abbreviations": [],
            "avg_msgs_per_burst": 1.0,
            "question_rate": 0.0,
            "apology_openers": [],
        }

    n = len(texts)
    lengths = sorted(len(t) for t in texts)

    emoji_counter: Counter[str] = Counter()
    with_emoji = 0
    for t in texts:
        found = EMOJI.findall(t)
        if found:
            with_emoji += 1
            emoji_counter.update(found)

    punct = Counter(c for c in (_punctuation_class(t) for t in texts) if c)
    if punct:
        top_class, top_n = punct.most_common(1)[0]
        punctuation = top_class if top_n / n >= 0.6 else "mixed"
    else:
        punctuation = "mixed"

    abbrev_counter: Counter[str] = Counter()
    for t in texts:
        tokens = set(_WORD.findall(t.lower()))
        for a in ABBREVIATIONS:
            if a in tokens:
                abbrev_counter[a] += 1

    openers = Counter(o for o in (_apology_opener(t) for t in texts) if o)

    return {
        "median_len_chars": max(1, _median_int(lengths)),
        "p90_len_chars": max(1, _percentile(lengths, 90)),
        "emoji_rate": _round(with_emoji / n),
        "top_emoji": _by_frequency(emoji_counter, 5),
        "punctuation": punctuation,
        "greeting_rate": _round(sum(1 for t in texts if _starts_with(t, GREETINGS)) / n),
        "signoff_rate": _round(sum(1 for t in texts if _ends_with(t, SIGNOFFS)) / n),
        "abbreviations": _by_frequency(abbrev_counter, 20),
        "avg_msgs_per_burst": _avg_msgs_per_burst(timestamps),
        "question_rate": _round(sum(1 for t in texts if "?" in t) / n),
        "apology_openers": _by_frequency(openers, 5),
    }


def _by_frequency(counter: Counter[str], limit: int) -> list[str]:
    """Most frequent first, ties broken by the value itself.

    The tiebreak is not cosmetic: without it the order is insertion-dependent, the
    content hash moves for an unchanged corpus, and Track A's Swift port could never
    match this implementation.
    """
    return [k for k, _ in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))][:limit]


def _avg_msgs_per_burst(timestamps: list[int] | None) -> float:
    """A burst is a run of sent messages each within BURST_GAP_SECONDS of the last.

    Someone who fires off four fragments where you would write one sentence has a
    materially different register, and this is the only statistic that catches it.
    """
    if not timestamps:
        return 1.0
    ts = sorted(timestamps)
    bursts = 1
    for prev, cur in zip(ts, ts[1:], strict=False):
        if cur - prev > BURST_GAP_SECONDS:
            bursts += 1
    return max(1.0, _round(len(ts) / bursts, 2))
