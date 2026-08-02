"""Redaction, including the lowercase-name path CONTRACTS.md section 7 requires.

The capitalised-name tests all passed while `"ill ask john smith about it"` leaked
untouched, which is exactly the failure mode the section calls out: the target corpus
is lowercase texting, so a pattern requiring `[A-Z]` is tested against samples that do
not resemble the data.
"""
from __future__ import annotations

import pytest
from boi_intel.redact import redact

# ------------------------------------------------------------- the categories


@pytest.mark.parametrize(
    "text",
    [
        "call me at +1 (555) 010-0042 when you land",
        "my number is 555-010-0042",
        "try 5550100042 instead",
    ],
)
def test_phone_numbers_are_redacted(text):
    out = redact(text)
    assert "[phone]" in out
    assert "555" not in out
    assert "0042" not in out


def test_emails_are_redacted():
    out = redact("my email is skyler.luk@example.com if thats easier")
    assert "[email]" in out
    assert "@" not in out
    assert "example.com" not in out


@pytest.mark.parametrize(
    "text", ["it came out to $1,240.50 total", "that cost 40 dollars", "like 15 bucks"]
)
def test_amounts_are_redacted(text):
    out = redact(text)
    assert "[amount]" in out


def test_street_addresses_are_redacted():
    out = redact("i live at 1600 Amphitheatre Pkwy now")
    assert "[address]" in out
    assert "Amphitheatre" not in out


# ------------------------------------------------- names, capitalised and not


def test_capitalised_full_names_are_redacted():
    out = redact("Jordan Feldman said he'd cover the rest")
    assert "[name]" in out
    assert "Jordan" not in out and "Feldman" not in out


@pytest.mark.parametrize(
    "text,leaked",
    [
        ("ill ask john smith about it", ["john smith", "john", "smith"]),
        ("talked to maria garcia yesterday", ["maria garcia", "maria", "garcia"]),
        ("priya patel is coming too", ["priya patel", "priya", "patel"]),
        ("we saw daniel okafor at the thing", ["daniel okafor", "daniel", "okafor"]),
    ],
)
def test_lowercase_full_names_are_redacted(text, leaked):
    """The regression CONTRACTS.md section 7 names explicitly."""
    out = redact(text)
    assert "[name]" in out, out
    for fragment in leaked:
        assert fragment not in out, f"{fragment!r} survived in {out!r}"


@pytest.mark.parametrize(
    "text",
    [
        # Ordinary texting that must survive intact, or the register is destroyed.
        "ok that works for me",
        "sorry been mia this week, work has been insane",
        "lmk when ur free and ill come thru",
        "prob gonna be late but ill be there",
        "ngl i completely spaced on that",
        "wait i totally forgot to reply to this",
        "omg yes im so down",
        "can i let u know tmrw",
        "haha yeah exactly",
        "im down whenever",
    ],
)
def test_ordinary_lowercase_texting_is_left_alone(text):
    assert redact(text) == text


@pytest.mark.parametrize(
    "text",
    [
        # Given names that are also ordinary English words must not trigger on their
        # word sense. "i will call you" must never become "i [name] you".
        "i will call you tomorrow",
        "you may want to check",
        "mark it down for friday",
        "i hope that works",
        "we can grant that",
    ],
)
def test_names_that_are_also_common_words_do_not_false_positive(text):
    assert redact(text) == text


def test_a_given_name_followed_by_a_common_word_is_not_a_full_name():
    """"sorry been mia this week" — `mia` is a given name, `this` is not a surname."""
    assert redact("sorry been mia this week") == "sorry been mia this week"


def test_redaction_preserves_sentence_shape():
    """A redacted exemplar is still a style sample: the shape survives, the identity
    does not."""
    out = redact("ill ask john smith about the $40 thing")
    assert out.startswith("ill ask ")
    assert out.endswith(" thing")
    assert "[name]" in out and "[amount]" in out
