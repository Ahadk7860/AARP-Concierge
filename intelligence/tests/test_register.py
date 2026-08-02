"""Register statistics, and the cross-language determinism rules behind them.

CONTRACTS.md section 6 pins percentile rounding because Tracks A and B are diffed on
identical input at integration. These tests are the Python half of that agreement.
"""
from __future__ import annotations

from boi_intel.redact import redact
from boi_intel.register import _median_int, _percentile, compute_register

# ------------------------------------------------------------------ percentiles


def test_percentile_is_nearest_rank_half_up():
    """`ceil(p/100 * n) - 1`, clamped. Worked by hand, not by calling the code."""
    vals = list(range(1, 21))  # n = 20, values 1..20, already sorted
    # ceil(90/100 * 20) - 1 = ceil(18) - 1 = 17  ->  vals[17] = 18
    assert _percentile(vals, 90) == 18
    # ceil(50/100 * 20) - 1 = ceil(10) - 1 =  9  ->  vals[9]  = 10
    assert _percentile(vals, 50) == 10


def test_percentile_at_n20_does_not_drift_by_one():
    """n = 20 is the case CONTRACTS.md section 6 calls out by name: banker's rounding
    and half-away-from-zero disagree here, and the disagreement silently changes
    voice_pack_version."""
    vals = list(range(1, 21))
    assert _percentile(vals, 90) == 18, "p90 stepped to the wrong rank at n=20"


def test_percentile_edges_and_clamping():
    assert _percentile([5], 90) == 5
    assert _percentile([5], 50) == 5
    assert _percentile([], 90) == 1
    assert _percentile([1, 2, 3], 100) == 3
    assert _percentile([1, 2, 3], 0) == 1  # clamped to index 0, never negative


def test_percentile_uses_integer_arithmetic_not_floats():
    """`p / 100` is not exactly representable, so a float ceiling can step to the next
    index. Sweep the range and require the integer rule exactly."""
    for n in range(1, 501):
        vals = list(range(1, n + 1))
        for p in (50, 90):
            expected = vals[max(0, min(n - 1, (p * n + 99) // 100 - 1))]
            assert _percentile(vals, p) == expected, (n, p)


def test_median_is_p50_under_the_same_rule():
    assert _median_int([1, 2, 3, 4, 5]) == 3
    assert _median_int([1, 2, 3, 4]) == 2  # p50 of n=4 is index 1, not an average
    assert _median_int(list(range(1, 21))) == 10


# ----------------------------------------------- the register must see raw text


SENTENCE_CASE_WITH_NAMES = [
    "Hey Sarah how are you",
    "Hey Sarah did you see that",
    "Hey Sarah are we still on",
    "Hey Sarah call me back",
    "Hey Sarah what time works",
    "Hey Sarah just checking in",
    "That sounds good to me",
    "I will be there soon",
    "Let me know either way",
    "Sounds like a plan",
]


def test_register_on_raw_text_sees_the_greeting_and_the_case():
    r = compute_register(SENTENCE_CASE_WITH_NAMES)
    assert r["punctuation"] == "sentence_case_no_period"
    assert r["greeting_rate"] == 0.6


def test_redacting_first_would_corrupt_both_statistics():
    """The exact failure CONTRACTS.md sections 6 and 7 forbid, demonstrated.

    This is not a test of production behaviour — it is the proof that the ordering
    rule is load-bearing. If this test ever starts agreeing with the raw register,
    redaction has stopped touching names and the rule can be revisited.
    """
    redacted_first = compute_register([redact(t) for t in SENTENCE_CASE_WITH_NAMES])
    raw = compute_register(SENTENCE_CASE_WITH_NAMES)

    # "Hey Sarah how are you" -> "[name] how are you": no longer a greeting, and the
    # first character is no longer upper case.
    assert redacted_first["greeting_rate"] < raw["greeting_rate"]
    assert redacted_first["punctuation"] != raw["punctuation"]
    assert redacted_first["punctuation"] == "lowercase_no_period"
    assert redacted_first["greeting_rate"] == 0.0


# ---------------------------------------------------------------- other statistics


def test_empty_corpus_returns_schema_valid_minimums():
    r = compute_register([])
    assert r["median_len_chars"] >= 1
    assert r["p90_len_chars"] >= 1
    assert r["avg_msgs_per_burst"] >= 1.0
    assert 0.0 <= r["emoji_rate"] <= 1.0


def test_bursts_count_messages_within_the_gap():
    # three messages a minute apart, then one a day later: 4 messages, 2 bursts
    base = 1_700_000_000
    ts = [base, base + 60, base + 120, base + 86_400]
    r = compute_register(["a", "b", "c", "d"], ts)
    assert r["avg_msgs_per_burst"] == 2.0


def test_emoji_rate_and_top_emoji_are_frequency_ordered():
    r = compute_register(["ok 😭", "yes 😭", "sure 🙏", "no emoji here"])
    assert r["emoji_rate"] == 0.75
    assert r["top_emoji"][0] == "😭"
