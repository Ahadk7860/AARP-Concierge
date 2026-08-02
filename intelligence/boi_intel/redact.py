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

# CONTRACTS.md section 7: **name redaction must not assume capitalization.** The target
# corpus is lowercase texting — the fixture register is literally `lowercase_no_period`
# — so a pattern requiring `[A-Z]` passes every test written against capitalised samples
# and leaks "ill ask john smith about it" untouched.
#
# Matching any two lowercase words would redact the corpus into confetti, so the trigger
# is a known given name followed by a plausible surname. Names that are also ordinary
# English words (will, may, mark, grant, bill, rose, hope, joy, art, dawn, drew, chase)
# are deliberately ABSENT: "i will call you" must not become "i [name] you".
COMMON_GIVEN_NAMES = frozenset(
    """
aaron abby abigail adam adrian aisha alan albert alex alexa alexander alexis alfred
alice alicia alison allison alyssa amanda amber amelia amy ana anders andre andrea
andrew angela angelo anita ann anna anne annie anthony antonio april ariana arjun
arthur ashley aubrey audrey austin ava avery bailey barbara beatriz becky ben benjamin
bernard beth bethany betty beverly bianca blake bobby bradley brandon brenda brendan
brett brian briana bridget brittany brooke bruce bryan caleb cameron camila candice
carl carla carlos carmen carol caroline carolyn carrie casey catherine cathy cecilia
chad charles charlotte chelsea cheryl chloe chris christian christina christine
christopher cindy claire clara clarence claudia cody colin colleen connor cooper
corey courtney craig cristina crystal curtis cynthia dale damian daniel daniela danielle
danny darren daryl david dean deborah debra declan denise dennis derek devin diana diane
diego dominic donald donna dorothy douglas dylan edgar edith eduardo edward edwin eileen
elaine eleanor elena eli elias elijah elise elizabeth ella ellen elliot emerson emily
emma enrique eric erica erik erin ernesto esteban esther ethan eugene eva evan evelyn
fabian faisal farah felipe felix fernando fiona florence francis francisco frank
franklin fred frederick gabriel gabriela gail gary gavin gemma genevieve george gerald
gilbert gina giovanni gloria gordon grace graham greg gregory gwen hana hannah harold
harriet harvey hazel heather hector heidi helen henry hiroshi holly howard hugo ian
ibrahim imani ines irene iris isaac isabel isabella isaiah ismael ivan ivy jack jackie
jackson jacob jacqueline jaime jake james jamie jane janet janice jared jasmine jason
javier jay jayden jean jeanne jeff jeffrey jenna jennifer jenny jeremy jerome jerry
jesse jessica jesus jill jim jimmy joan joann joanna joaquin jocelyn joel john johnny
jonathan jordan jorge jose joseph josephine josh joshua juan judith judy julia julian
julie justin kaitlyn kara karen karl kate katherine kathleen kathryn kathy katie katrina
kayla keith kelly kelsey ken kendra kenneth kevin khalid kim kimberly kirsten krista
kristen kristin kyle lance larry laura lauren laurie lawrence leah lee leila lena
leo leon leonard leslie liam lila lillian lily linda lindsay lionel lisa logan lois
lorena loretta lori louis louise lucas lucia lucy luis luke lydia lyle mabel maddie
madeline madison malcolm manuel marc marcia marco marcus margaret maria mariana marie
marilyn mario marion marisa marissa marjorie martha martin marvin mary mason mateo
mathew matthew maureen maurice maya megan meghan melanie melissa melvin mercedes
meredith mia micah michael michelle miguel mike mila miles miriam mitchell mohammed
molly monica morgan muhammad myra nadia nancy naomi natalie nathan nathaniel neil
nelson nia nicholas nicole nikhil nina noah noel nora norma norman olivia omar oscar
owen pablo pamela patricia patrick paul paula paulina pedro peggy penelope peter
philip phillip phoebe phyllis pierre priya quentin quinn rachel rafael rahul ralph
ramon randall randy raul raymond rebecca regina renee reuben rhonda ricardo richard
rick ricky riley rita robert roberta roberto robin rodney roger roland roman ronald
rosa rosemary ross roy ruben ruby russell ruth ryan sabrina sadie salvador samantha
samir samuel sandra sandy santiago sara sarah saul scott sean sebastian selena serena
sergio seth shane shannon sharon shaun shawn sheila shelby sherry shirley sidney
simon sofia sonia sophia sophie spencer stanley stella stephanie stephen steve steven
stuart sue susan suzanne sylvia tamara tammy tanya tara ted teresa terrence terry
tessa thelma theodore theresa thomas tiffany tim timothy tina tobias todd tom tommy
tonya tracy travis trevor tricia tristan troy tyler tyrone valeria valerie vanessa
vera veronica vicente vicki victor victoria vincent violet virginia vivian walter
wanda warren wayne wendy wesley whitney wilfredo william willie wyatt xavier yara
yasmin yolanda yuki yusuf yvonne zachary zara zoe
""".split()
)

# The token AFTER a given name has to look like a surname. These are the words that
# most often follow a first name in ordinary texting, and none of them is one.
_NOT_A_SURNAME = frozenset(
    """
a about above after again against all also am an and any are around as asked at back
be because been before being below between both but by came can cant come coming could
did didnt do does doesnt doing done dont down during each else even ever every for from
further get gets getting go goes going gone got had has have having he her here hers
him his how i if in into is isnt it its just keep kept knew know knows let lets like
liked likes made make makes many may me might mine more most much must my need needs
never new next no nor not now of off on once one only or other others ought our out
over own said same saw say says see seen she should since so some soon still such take
takes tell tells than that the their them then there these they thing things think this
those though thought through to today together told tomorrow tonight too took two under
until up upon us use used very want wanted was wasnt we well went were what when where
whether which while who whom why will with within without wont would yes yet you your
""".split()
)

_LOWER_FULL_NAME = re.compile(r"\b([a-z][a-z'-]{1,20})\s+([a-z][a-z'-]{1,20})\b")

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
    def capitalized(m: re.Match[str]) -> str:
        return "[name]" if m.group(0).lower() not in _NAME_ALLOWLIST else m.group(0)

    out = FULL_NAME.sub(capitalized, text)

    def lowercase(m: re.Match[str]) -> str:
        first, second = m.group(1), m.group(2)
        if first not in COMMON_GIVEN_NAMES or second in _NOT_A_SURNAME:
            return m.group(0)
        return "[name]"

    return _LOWER_FULL_NAME.sub(lowercase, out)


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
