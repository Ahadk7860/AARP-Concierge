"""Redaction, applied before an exemplar is ever serialized.

CONTRACTS.md section 7: phone numbers, email addresses, street addresses, dollar
amounts, and third-party full names come out. A redacted exemplar is just as good a
style sample and carries none of the risk — the drafter needs to know *how* the user
writes, never *what* they said.

Every rule replaces with a bracketed token rather than deleting, so the shape of the
sentence survives and the register statistics stay honest.
"""
from __future__ import annotations

import re

EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")

# +1 (555) 010-0001 / 555-010-0001 / 5550100001 / +15550100001
PHONE = re.compile(
    r"(?<![\w])"
    r"(?:\+\d{1,3}[\s.-]?)?"
    r"(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}"
    r"(?![\w])"
)

# $40, $1,200.50, 40 dollars, 15 bucks
AMOUNT = re.compile(
    r"(?<![\w])(?:[$£€]\s?\d[\d,]*(?:\.\d{1,2})?"
    r"|\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars?|bucks|usd|euros?|quid))(?![\w])",
    re.IGNORECASE,
)

_STREET_TYPES = (
    r"st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|"
    r"pl|place|way|ter|terrace|pkwy|parkway|cir|circle|hwy|highway"
)
# 1600 Amphitheatre Pkwy — a house number followed by words and a street type.
ADDRESS = re.compile(
    rf"(?<![\w])\d{{1,6}}\s+(?:[A-Za-z0-9'.-]+\s+){{0,4}}(?:{_STREET_TYPES})\b\.?",
    re.IGNORECASE,
)

# Two or more consecutive capitalised words: "John Smith", "Mary Anne Berg".
# Deliberately conservative — a single capitalised word is far more often a sentence
# opener, a brand, or a place than it is a third party's identity.
FULL_NAME = re.compile(r"\b[A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){1,3}\b")

# Openers and common two-word phrases that FULL_NAME would otherwise eat. Redacting
# "Thank You" as a name would corrupt the very register signal we are measuring.
_NAME_ALLOWLIST = frozenset(
    {
        "thank you",
        "thanks so",
        "happy birthday",
        "merry christmas",
        "happy new",
        "happy new year",
        "good morning",
        "good afternoon",
        "good evening",
        "good night",
        "oh my",
        "oh my god",
        "my bad",
        "no worries",
        "see you",
        "talk soon",
        "let me",
        "i am",
        "i will",
        "i think",
        "i know",
        "i can",
    }
)


def _redact_names(text: str) -> str:
    def sub(m: re.Match[str]) -> str:
        return "[name]" if m.group(0).lower() not in _NAME_ALLOWLIST else m.group(0)

    return FULL_NAME.sub(sub, text)


def redact(text: str) -> str:
    """Strip every category CONTRACTS.md section 7 names, in a fixed order.

    Order matters: emails carry digits that PHONE would otherwise chew into, and
    addresses start with a number that AMOUNT would not claim but PHONE might.
    """
    out = EMAIL.sub("[email]", text)
    out = ADDRESS.sub("[address]", out)
    out = PHONE.sub("[phone]", out)
    out = AMOUNT.sub("[amount]", out)
    out = _redact_names(out)
    return re.sub(r"[ \t]{2,}", " ", out).strip()
