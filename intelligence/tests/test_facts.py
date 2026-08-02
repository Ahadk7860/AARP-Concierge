"""`gist.v1.facts` — the fabrication-gate allowlist.

Both failure directions are tested, because both cost something. Under-population makes
drafts vague; over-population means the gate has stopped gating. The nastiest bug found
building this was the second kind: `re.IGNORECASE` applied to a capitalised-name pattern
turns `[A-Z][a-z]+` into "any word", so whole sentences were being harvested as `names`
and carried into a document that crosses the boundary to the cloud.
"""
from __future__ import annotations

import pytest
from boi_intel.facts import MAX_FACT_WORDS, MAX_PER_CATEGORY, extract_facts, infer_topic

CATEGORIES = ("dates", "times", "places", "amounts", "names")


# ------------------------------------------------------------------ both edges


def test_a_thread_with_specifics_yields_them():
    facts = extract_facts([
        "are you still coming on the 14th",
        "we need to book by friday",
    ])
    assert "the 14th" in facts["dates"]
    assert "friday" in [d.lower() for d in facts["dates"]]


def test_a_thread_with_no_specifics_yields_five_empty_lists():
    facts = extract_facts(["ok sounds good", "no worries at all", "lmk what you think"])
    assert facts == {"dates": [], "times": [], "places": [], "amounts": [], "names": []}


def test_every_category_is_always_present():
    """`facts` is structurally complete even for an empty thread — the validator in 04
    reads all five keys unconditionally."""
    for messages in ([], [""], ["hi"]):
        assert set(extract_facts(messages)) == set(CATEGORIES)


# ------------------------------------------------------- the categories in turn


def test_times_are_extracted_as_clock_readings():
    facts = extract_facts(["can we meet at 3pm", "or 10:30 tomorrow", "noon works too"])
    assert "3pm" in facts["times"]
    assert "10:30" in facts["times"]
    assert "noon" in facts["times"]
    assert not any(t.startswith("at ") for t in facts["times"]), facts["times"]


def test_amounts_are_extracted():
    facts = extract_facts(["you owe me $40 for the tickets", "venmo me 15 bucks"])
    assert "$40" in facts["amounts"]
    assert "15 bucks" in facts["amounts"]


def test_places_are_anchored_on_a_preposition():
    facts = extract_facts(["lets meet at the Ferry Building", "ill be at the airport"])
    assert "Ferry Building" in facts["places"]
    assert any("airport" in p.lower() for p in facts["places"])


def test_names_capitalised_and_lowercase():
    facts = extract_facts(["Jordan Feldman is coming", "ill ask john smith about it"])
    assert "Jordan Feldman" in facts["names"]
    assert "john smith" in facts["names"]


# ------------------------------------------- over-population is a gate failure


def test_no_fact_is_a_prose_span():
    """The regression that motivated the per-message scan and case-sensitive patterns.

    Under the old code these inputs produced `names` entries like
    `"you ever hear back about"` and places like `"all\\nlmk what you"`.
    """
    messages = [
        "are you still coming on the 14th",
        "we need to book by friday",
        "hey!! how have you been",
        "did you ever hear back about that",
        "call me when you get a sec",
        "no worries at all",
        "lmk what you think",
        "ok sounds good",
    ]
    facts = extract_facts(messages)
    for category in CATEGORIES:
        for value in facts[category]:
            assert "\n" not in value, f"{category}: {value!r} spans a message boundary"
            assert len(value.split()) <= MAX_FACT_WORDS, f"{category}: {value!r}"


def test_facts_never_splice_two_messages_together():
    """Each message is scanned alone. A pattern that runs across the seam invents a
    sentence nobody wrote."""
    facts = extract_facts(["no worries at all", "Lmk what you think"])
    for category in CATEGORIES:
        for value in facts[category]:
            assert "all" not in value.lower() or len(value.split()) <= 2, value


def test_ordinary_chatter_produces_no_names():
    """`[A-Z][a-z]+` under IGNORECASE matches every word. This is the guard."""
    facts = extract_facts([
        "ok sounds good", "no worries at all", "lmk what you think",
        "did you ever hear back about that", "call me when you get a sec",
    ])
    assert facts["names"] == []
    assert facts["places"] == []


def test_redundant_substrings_are_suppressed():
    """"the 14th" and "14th" are one date; keeping both spends two allowlist slots."""
    facts = extract_facts(["are you still coming on the 14th"])
    assert facts["dates"] == ["the 14th"]


def test_a_place_is_not_also_listed_as_a_person():
    facts = extract_facts(["meet me at the Ferry Building"])
    assert "Ferry Building" in facts["places"]
    assert "Ferry Building" not in facts["names"]


def test_each_category_is_capped():
    """An unbounded allowlist is not a gate."""
    messages = [f"can we do the {n}th" for n in range(1, 29)]
    facts = extract_facts(messages)
    for category in CATEGORIES:
        assert len(facts[category]) <= MAX_PER_CATEGORY


def test_extraction_is_deterministic():
    messages = ["are you still coming on the 14th", "book by friday", "$40 total"]
    assert extract_facts(messages) == extract_facts(messages)


# ---------------------------------------------------------------------- topic


@pytest.mark.parametrize(
    "messages,expected",
    [
        (["we need to book the flight", "what hotel are you at"], "travel_planning"),
        (["are you free for dinner", "what time works"], "scheduling"),
        (["venmo me for the tickets", "you still owe me"], "money"),
        (["hey how have you been", "long time no talk"], "check_in"),
        (["ok", "sure"], None),
        ([], None),
    ],
)
def test_topic_is_a_label_from_a_closed_vocabulary(messages, expected):
    assert infer_topic(messages) == expected


def test_topic_is_never_a_quotation():
    messages = ["are you still coming on the 14th, we need to book by friday"]
    topic = infer_topic(messages)
    assert topic is None or topic not in messages[0]
    assert topic is None or len(topic) <= 40
