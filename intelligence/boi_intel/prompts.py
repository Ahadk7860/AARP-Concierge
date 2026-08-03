"""Prompt construction, and the cache split that is the whole cost story.

`ModelProvider.complete(system, cached_prefix, suffix)` takes three arguments rather
than one because the split is economic, not stylistic:

- **`cached_prefix` is the voice pack.** It is static per
  `(user_id, contact_id, voice_pack_version)` for a week — forty exemplars and a
  register block, the largest part of the prompt, re-sent every single morning.
- **`suffix` is the gist.** A few hundred tokens that change every day.

Collapsing them into one string is the single most expensive mistake available here
(`providers/fake.py` says so in as many words), and retrofitting the split means
rewriting every prompt. So it is built in from the first line.

**Nothing in this module logs a prompt.** `prompt_hash` exists so a bad draft is
reproducible from `(voice_pack_version, gist_id, prompt_version, model_id)` without a
log full of somebody's messages sitting in an observability vendor (CONTRACTS.md § 6).
"""

from __future__ import annotations

import hashlib
import json

PROMPT_VERSION_DEFAULT = "draft.v1"

# The instruction that makes the two candidates a real choice rather than two
# paraphrases. `answer` and `defer` are the decision the user has actually been
# avoiding, which is why the thread went quiet in the first place.
SYSTEM = """You write text messages as the user, in the user's own voice.

You will be given the user's own past messages as style exemplars, then a summary of
what they owe someone. Write exactly two candidate replies.

The two candidates MUST differ in STANCE, not in phrasing:
  - "answer": acknowledge the silence, then commit. Give the actual answer.
  - "defer":  acknowledge the silence, then buy time honestly. Do not commit.
Two rewordings of the same message is a fake choice and is worse than one message.

Both candidates MUST open by owning the silence. That is what the user actually owes,
and a reply that skips it reads as if nothing happened.

Rules:
  - Match the exemplars' register exactly: capitalisation, punctuation, abbreviations,
    emoji use, and length. If the exemplars are lowercase with no full stops, write
    lowercase with no full stops.
  - You may mention a specific date, time, place, amount or name ONLY if it appears in
    the ALLOWED SPECIFICS list. Anything else is an invented commitment sent in the
    user's name.
  - Never write like an assistant. No "just circling back", no "reaching out", no
    "I hope this finds you well", no sign-off, no em dash.
  - Keep each candidate close to the user's typical message length.

Return ONLY minified JSON, no markdown fence:
{"candidates":[{"stance":"answer","text":"..."},{"stance":"defer","text":"..."}]}"""


def render_voice_pack(pack: dict) -> str:
    """The cached prefix. Static for a week per contact, so it carries everything that
    does not change: the register block and the exemplars."""
    register = pack.get("register", {})
    lines = [
        "USER STYLE PROFILE",
        f"typical length: {register.get('median_len_chars')} chars "
        f"(90th percentile {register.get('p90_len_chars')})",
        f"punctuation: {register.get('punctuation')}",
        f"emoji rate: {register.get('emoji_rate')}",
        f"messages per burst: {register.get('avg_msgs_per_burst')}",
        f"question rate: {register.get('question_rate')}",
    ]
    if register.get("top_emoji"):
        lines.append(f"emoji they use: {' '.join(register['top_emoji'])}")
    if register.get("abbreviations"):
        lines.append(f"abbreviations they use: {', '.join(register['abbreviations'])}")
    if register.get("apology_openers"):
        lines.append(f"how they open an apology: {'; '.join(register['apology_openers'])}")

    lines.append("")
    lines.append("THE USER'S OWN PAST MESSAGES (imitate these exactly):")
    lines += [f"- {e}" for e in pack.get("exemplars", [])]
    return "\n".join(lines)


def render_gist(gist: dict) -> str:
    """The suffix. Changes every day, so it is deliberately outside the cached block.

    The ALLOWED SPECIFICS list is `gist.v1.facts` verbatim — the fabrication-gate
    allowlist, restated to the model as an instruction so the validator in 04 has less
    to reject rather than more.
    """
    facts = gist.get("facts", {})
    allowed = [
        *facts.get("dates", []),
        *facts.get("times", []),
        *facts.get("places", []),
        *facts.get("amounts", []),
        *facts.get("names", []),
    ]
    lines = [
        "WHAT YOU OWE THIS PERSON",
        # The id is in the suffix because `providers/fake.py` replays on
        # `gist_id_contains`, and because it is the handle that makes a bad draft
        # reproducible from the log without the log holding any prose.
        f"gist id: {gist.get('gist_id')}",
        f"situation: {gist.get('gist')}",
        f"state: {gist.get('state')}",
        f"days since the last message: {gist.get('days_silent')}",
        f"they asked a question: {'yes' if gist.get('unanswered_question') else 'no'}",
    ]
    if gist.get("topic"):
        lines.append(f"topic: {gist['topic']}")
    if gist.get("has_deadline") and gist.get("deadline_hint"):
        lines.append(f"there is a deadline: {gist['deadline_hint']}")

    lines.append("")
    lines.append(
        "ALLOWED SPECIFICS (you may mention these and NOTHING else of this kind): "
        + (", ".join(allowed) if allowed else "none — do not name any specific")
    )
    lines.append("")
    lines.append("Write the two candidates now.")
    return "\n".join(lines)


_RETRY_GUIDANCE = {
    "length_gate": "Both were too long. Match the typical length above, not a paragraph.",
    "register_gate": "Wrong register: match the capitalisation, full stops and emoji use exactly.",
    "fabrication_gate": (
        "You named a date, time, place, amount or person that is NOT in ALLOWED "
        "SPECIFICS. Use only what is listed, or nothing."
    ),
    "forbidden_phrase": "You wrote like an assistant. No stock phrases, no sign-off, no em dash.",
    "stance_collision": "Both had the same stance. One must commit, the other must buy time.",
    "empty": "Return exactly two candidates as minified JSON.",
}


def retry_note(failures: list[str]) -> str:
    """The correction appended to the suffix on the second and final attempt.

    Naming the failures is the whole point. A blind retry at temperature 0.9 is a coin
    flip; telling the model it wrote 210 characters against a 34-character register is
    information it can act on.
    """
    if not failures:
        return ""
    lines = ["", "YOUR PREVIOUS ATTEMPT WAS REJECTED:"]
    lines += [f"- {_RETRY_GUIDANCE.get(f, f)}" for f in failures]
    lines.append("Write two new candidates that fix all of the above.")
    return "\n".join(lines)


def cache_key(user_id: str, contact_id: str, voice_pack_version: str) -> str:
    """`(user_id, contact_id, voice_pack_version)` — and deliberately nothing else.

    The gist is absent on purpose. Including it would produce a new key every morning
    and the cached prefix would never be reused, which is the entire saving.
    """
    raw = f"{user_id}|{contact_id}|{voice_pack_version}"
    return "pc_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def prompt_hash(system: str, cached_prefix: str, suffix: str) -> str:
    """A reproducibility handle for the prompt, safe to log.

    CONTRACTS.md § 6: log the prompt hash, never the prompt. The hash plus
    `(voice_pack_version, gist_id, prompt_version, model_id)` reproduces a bad draft
    exactly; the prompt itself is full of the user's messages.
    """
    digest = hashlib.sha256()
    for part in (system, cached_prefix, suffix):
        digest.update(part.encode("utf-8"))
        digest.update(b"\x00")
    return "ph_" + digest.hexdigest()[:16]


def parse_candidates(raw: str) -> list[dict]:
    """Pull `{"candidates":[...]}` out of whatever the model returned.

    Models fence JSON in markdown and prepend chatter regardless of instructions, so
    this tolerates both and returns `[]` when there is nothing usable. Returning `[]`
    is correct: a bundle with zero candidates is a legitimate degraded outcome, and
    guessing at malformed output is how a half-parsed sentence reaches somebody's
    friend.
    """
    text = (raw or "").strip()
    if not text:
        return []

    if "```" in text:
        blocks = text.split("```")
        for block in blocks[1::2]:
            block = block.removeprefix("json").strip()
            if block.startswith("{"):
                text = block
                break

    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return []
    try:
        payload = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return []

    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        return []

    out = []
    for c in candidates:
        if not isinstance(c, dict):
            continue
        stance, text_value = c.get("stance"), c.get("text")
        if stance in ("answer", "defer") and isinstance(text_value, str):
            out.append({"stance": stance, "text": text_value.strip()})
    return out
