"""Gist production: SQL first, model second.

    python -m boi_intel.gist --db /tmp/boi-b/chat.db --top 5 --out /tmp/boi-b/out/gists/

A gist is what lets the cloud learn **what you owe someone** without learning **what
they said**. It reads the other person's text, so it runs on the Mac; only the
abstraction crosses the boundary.

Two producers sit behind one interface:

- `SqlGistProducer` — pure arithmetic over thread statistics, with the gist string built
  from templates. Zero model, zero download, works on an Intel Mac with a full disk.
  CONTRACTS.md § 11 item 11 makes this the **permanent fallback**, not a stopgap.
- `LocalModelGistProducer` — a 3–4B class model via MLX, with a llama.cpp CPU fallback.
  Downloaded lazily, **after** the first report is delivered, never blocking onboarding.

`select_producer` degrades to SQL whenever the model is missing, undownloaded, or
unloadable, and records why. It never raises: a vague gist beats no gist, and both beat
a hallucinated one.

**The gist string is templated, never quoted.** That is what keeps the digest boundary
intact — see `test_gist.py`, which seeds a distinctive inbound sentence and asserts it
appears nowhere in the output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from boi_intel import chatdb
from boi_intel.facts import extract_facts, infer_topic
from boi_intel.threads import ThreadStats, load_threads
from boi_intel.voice import resolve_salt

SCHEMA_VERSION = "gist.v1"
MAX_GIST_CHARS = 140

MODEL_ENV_VAR = "BOI_LOCAL_GIST_MODEL"
MODEL_CACHE_DIR = pathlib.Path(os.environ.get("BOI_MODEL_CACHE", "/tmp/boi-b/models"))

DORMANT_DAYS = 180
FADING_DAYS = 21
ACTION_NEEDED_DAYS = 2
REVIVED_MAX_DAYS = 7
REVIVED_PRIOR_GAP_DAYS = 90

# A date only counts as a deadline while it could still be ahead of you. "They mentioned
# the 14th" is useful three days later and false eleven months later, and `has_deadline`
# on a year-old thread is a fabricated commitment in the user's own name.
DEADLINE_MAX_DAYS_SILENT = 30


# --------------------------------------------------------------------------- state


def classify(stats: ThreadStats) -> str | None:
    """One of `gist.v1.state`, or `None` when the thread needs nothing.

    `None` is the common case and it is load-bearing: a healthy two-way thread has no
    gist, so the brief has nothing to say about it. Forcing every thread into a state
    would fill the morning text with people who are perfectly fine — and "Sarah is
    fading" about someone you texted yesterday is the kind of confident wrong answer
    that costs trust permanently.

    `birthday` is deliberately never returned. It requires a birth date, which lives in
    Contacts.app and is Track A's to supply; inventing one from message text would be
    fabrication. See NOTES.md.
    """
    if stats.days_silent >= DORMANT_DAYS:
        return "dormant"
    if not stats.last_from_me and stats.days_silent >= ACTION_NEEDED_DAYS:
        return "action_needed"
    if stats.days_silent <= REVIVED_MAX_DAYS and stats.max_gap_days >= REVIVED_PRIOR_GAP_DAYS:
        return "revived"
    if stats.days_silent >= FADING_DAYS:
        return "fading"
    return None


def priority(stats: ThreadStats, state: str) -> float:
    """A 0..1 score the brief sorts on, built from momentum and obligation.

    Reciprocity is deliberately absent. CONTRACTS.md § 6: across 25 real relationships
    the spread was 0.465–0.615 with sd 0.034 — it carries almost no information and it
    is the most legally dangerous metric in the category.
    """
    score = 0.0

    # Somebody waiting on you is the single strongest signal.
    if not stats.last_from_me:
        score += 0.35
    if stats.unanswered_question:
        score += 0.20

    # Recency shaped as a plateau: a few days is urgent, a year is archaeology.
    d = stats.days_silent
    if d <= 1:
        recency = 0.20
    elif d <= 14:
        recency = 0.30
    elif d <= 45:
        recency = 0.25
    elif d <= 120:
        recency = 0.15
    else:
        recency = 0.05
    score += recency

    # Closeness, by volume, saturating so a 3000-message thread cannot dominate.
    score += min(stats.total_messages / 2000.0, 1.0) * 0.10

    # Losing momentum is the thing worth surfacing.
    if stats.momentum < 0.5:
        score += 0.05

    if state == "action_needed":
        score += 0.05

    return round(max(0.0, min(1.0, score)), 4)


# ---------------------------------------------------------------------- gist text


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def deadline_for(stats: ThreadStats, facts: dict[str, list[str]]) -> str | None:
    """The date a draft may treat as pending, or `None`.

    Gated on recency: see `DEADLINE_MAX_DAYS_SILENT`. The date stays in `facts` either
    way — the drafter may still mention it — but only a recent one is promoted to
    `has_deadline`, which is what the brief sorts and phrases on.
    """
    if stats.days_silent > DEADLINE_MAX_DAYS_SILENT:
        return None
    return facts["dates"][0] if facts["dates"] else None


def sql_gist_text(stats: ThreadStats, state: str, facts: dict[str, list[str]]) -> str:
    """A templated sentence, second person, describing what the user owes.

    Every branch is a format string over statistics and over `facts` tokens that were
    themselves pattern-extracted. No branch can emit a span of the other person's prose,
    which is the property the no-verbatim test pins down.

    Phrasing follows CONTRACTS.md § 6: invitation, never verdict. "they are waiting on
    a reply" states a fact about the thread; "they don't text you back" is a judgement
    about a person and never ships.
    """
    days = stats.days_silent
    deadline = deadline_for(stats, facts)

    if state == "action_needed":
        if stats.unanswered_question and deadline:
            text = (
                f"they asked you something {_plural(days, 'day')} ago and mentioned "
                f"{deadline}; you have not replied"
            )
        elif stats.unanswered_question:
            text = f"they asked you a question {_plural(days, 'day')} ago and you have not replied"
        elif deadline:
            text = (
                f"they wrote last {_plural(days, 'day')} ago about {deadline}; you have not replied"
            )
        else:
            text = f"they sent the last message {_plural(days, 'day')} ago and are waiting on you"
    elif state == "revived":
        text = (
            f"back in touch {_plural(days, 'day')} ago after "
            f"{_plural(stats.max_gap_days, 'day')} of silence"
        )
    elif state == "dormant":
        text = f"neither of you has written in {_plural(days, 'day')}"
    elif state == "fading":
        latency = stats.median_reply_latency_seconds
        if latency is not None and latency < 3600:
            text = (
                f"you used to reply within {_plural(max(1, latency // 60), 'minute')}; "
                f"{_plural(days, 'day')} quiet now"
            )
        else:
            text = (
                f"{_plural(days, 'day')} quiet after "
                f"{_plural(stats.total_messages, 'message')} between you"
            )
    else:
        text = f"{_plural(days, 'day')} since the last message"

    if len(text) > MAX_GIST_CHARS:
        text = text[:MAX_GIST_CHARS].rstrip()
    return text


def gist_id(contact_id: str, state: str, as_of: str) -> str:
    digest = hashlib.sha256(f"{contact_id}|{state}|{as_of}".encode()).hexdigest()
    return "g_" + digest[:12]


# ----------------------------------------------------------------------- producers


class GistProducer(Protocol):
    """Both producers emit a complete `gist.v1` body. The SQL one always can."""

    producer: str
    model_id: str | None

    def available(self) -> bool: ...

    def produce(self, contact_id: str, stats: ThreadStats, state: str, as_of: str) -> dict: ...


@dataclass
class SqlGistProducer:
    """Arithmetic and templates. Always available, by construction."""

    producer: str = "sql"
    model_id: str | None = None

    def available(self) -> bool:
        return True

    def produce(self, contact_id: str, stats: ThreadStats, state: str, as_of: str) -> dict:
        # AMENDMENT-001: prefer the allowlist the Mac already extracted. On the chat.db
        # path `stats.facts` is None and this re-extracts from the tail, unchanged.
        facts = stats.facts if stats.facts is not None else extract_facts(stats.recent_inbound_text)
        topic = infer_topic(stats.recent_inbound_text)
        deadline = deadline_for(stats, facts)

        return {
            "schema_version": SCHEMA_VERSION,
            "gist_id": gist_id(contact_id, state, as_of),
            "contact_id": contact_id,
            # `display` is deliberately omitted — see NOTES.md. The only name Track B
            # can see is the raw handle, and CONTRACTS.md § 3 says the server must
            # never receive a raw handle for anyone but the account holder.
            "state": state,
            "days_silent": stats.days_silent,
            "unanswered_question": stats.unanswered_question,
            "topic": topic,
            "has_deadline": deadline is not None,
            "deadline_hint": deadline,
            "gist": sql_gist_text(stats, state, facts),
            "facts": facts,
            "priority": priority(stats, state),
            "producer": self.producer,
            "model_id": None,
            "as_of": as_of,
        }


class ModelProducerNotAvailableOnDigestPath(RuntimeError):
    """Raised rather than degraded. See `gists_from_digest`.

    Distinct from `ModelUnavailable`, which means "no backend, use SQL" and is CAUGHT and
    degraded per thread. This one means "you asked for something that cannot be correct",
    and degrading it quietly is how the empty-corpus hole survived.
    """


class ModelUnavailable(RuntimeError):
    """The local model cannot be used. Always caught; never reaches a caller."""


@dataclass
class LocalModelGistProducer:
    """A 3–4B class local model, MLX first with a llama.cpp CPU fallback.

    The weights are ~2GB and are fetched **after** the first report is delivered, never
    during onboarding: a two-gigabyte download in front of a first run is a drop-off
    window, and the SQL producer already answers the question.

    Nothing here fabricates model output. With no backend installed, `available()` is
    False and `select_producer` falls back — which is the state of this environment; see
    NOTES.md.
    """

    model_id: str
    producer: str = "local_model"
    backend: object | None = None
    _reason: str = ""

    def available(self) -> bool:
        return self.load_backend() is not None

    def unavailable_reason(self) -> str:
        self.load_backend()
        return self._reason

    def load_backend(self) -> object | None:
        """Import MLX, then llama.cpp. Both absent means unavailable, not an error."""
        if self.backend is not None:
            return self.backend
        if not self.model_id:
            self._reason = f"{MODEL_ENV_VAR} is empty"
            return None
        if not self.model_path().exists():
            self._reason = f"weights not downloaded to {self.model_path()}"
            return None
        for loader, name in ((self._load_mlx, "mlx_lm"), (self._load_llama_cpp, "llama_cpp")):
            try:
                backend = loader()
            except Exception as exc:  # noqa: BLE001 — any import/load failure degrades
                self._reason = f"{name} unavailable: {exc}"
                continue
            if backend is not None:
                self.backend = backend
                self._reason = ""
                return backend
        self._reason = self._reason or "no local model backend installed"
        return None

    def model_path(self) -> pathlib.Path:
        return MODEL_CACHE_DIR / self.model_id.replace("/", "__")

    def _load_mlx(self) -> object | None:
        import importlib

        if importlib.util.find_spec("mlx_lm") is None:
            return None
        mlx_lm = importlib.import_module("mlx_lm")
        model, tokenizer = mlx_lm.load(str(self.model_path()))
        return _MlxBackend(mlx_lm, model, tokenizer)

    def _load_llama_cpp(self) -> object | None:
        import importlib

        if importlib.util.find_spec("llama_cpp") is None:
            return None
        llama_cpp = importlib.import_module("llama_cpp")
        gguf = next(self.model_path().glob("*.gguf"), None)
        if gguf is None:
            self._reason = f"no .gguf under {self.model_path()}"
            return None
        return _LlamaCppBackend(llama_cpp.Llama(model_path=str(gguf), n_ctx=4096))

    def download(self, force: bool = False) -> pathlib.Path:
        """Fetch the weights into the cache. Called after the report, never before.

        Raises `ModelUnavailable` rather than a transport error so every caller has one
        thing to catch.
        """
        target = self.model_path()
        if target.exists() and not force:
            return target
        try:
            import importlib

            if importlib.util.find_spec("huggingface_hub") is None:
                raise ModelUnavailable("huggingface_hub is not installed; add the `local` extra")
            hub = importlib.import_module("huggingface_hub")
            target.parent.mkdir(parents=True, exist_ok=True)
            hub.snapshot_download(repo_id=self.model_id, local_dir=str(target))
        except ModelUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ModelUnavailable(f"could not download {self.model_id}: {exc}") from exc
        return target

    def produce(self, contact_id: str, stats: ThreadStats, state: str, as_of: str) -> dict:
        """Model-written gist string over SQL-derived structure.

        The model rewrites only the 140-character sentence. Every other field — state,
        days_silent, facts, priority — stays arithmetic, so a confused model cannot
        invent a deadline or move somebody up the brief. The result is validated and
        falls back to the SQL sentence if the model returns anything unusable.
        """
        base = SqlGistProducer().produce(contact_id, stats, state, as_of)
        backend = self.load_backend()
        if backend is None:
            raise ModelUnavailable(self._reason)

        text = backend.summarize(stats.recent_inbound_text, state, base["facts"])
        text = (text or "").strip().replace("\n", " ")
        if (
            not text
            or len(text) > MAX_GIST_CHARS
            or _quotes_the_corpus(text, stats.recent_inbound_text)
        ):
            return base
        base["gist"] = text
        base["producer"] = self.producer
        base["model_id"] = self.model_id
        return base


def _quotes_the_corpus(text: str, inbound: list[str], min_run: int = 6) -> bool:
    """True if `text` reproduces a run of `min_run`+ consecutive words from an inbound
    message. The gist crosses the boundary; a quotation inside it defeats the whole
    separation, so a model that copies gets its output discarded.

    **An EMPTY corpus returns True, and that reversal is the point.** This function
    iterates `inbound` looking for overlap, so with nothing to iterate it returned False
    — "does not quote the corpus" — for every input, including a sentence the model
    invented outright. It is the only guard on a model-written gist besides a length
    check, so on the digest-driven path (`recent_inbound_text=[]` always, correctly, since
    the digest carries no prose) ANY hallucination under 140 characters was accepted,
    became `gist["gist"]`, was fed to the drafter as `situation:`, and was shown to the
    user as the brief item body.

    The question this answers is not "did it quote?" but "can I show this to somebody?",
    and with no corpus to check against the answer is no. A guard that passes because its
    input is empty is not a guard.
    """
    if not inbound:
        return True
    words = text.lower().split()
    if len(words) < min_run:
        return False
    runs = {" ".join(words[i : i + min_run]) for i in range(len(words) - min_run + 1)}
    return any(run in " ".join(m.lower().split()) for m in inbound for run in runs)


class _MlxBackend:
    def __init__(self, mlx_lm, model, tokenizer) -> None:
        self.mlx_lm, self.model, self.tokenizer = mlx_lm, model, tokenizer

    def summarize(self, inbound: list[str], state: str, facts: dict) -> str:
        return self.mlx_lm.generate(
            self.model,
            self.tokenizer,
            prompt=_gist_prompt(inbound, state, facts),
            max_tokens=64,
            verbose=False,
        )


class _LlamaCppBackend:
    def __init__(self, llama) -> None:
        self.llama = llama

    def summarize(self, inbound: list[str], state: str, facts: dict) -> str:
        out = self.llama(_gist_prompt(inbound, state, facts), max_tokens=64)
        return out["choices"][0]["text"]


def _gist_prompt(inbound: list[str], state: str, facts: dict) -> str:
    allowed = ", ".join(sum(facts.values(), [])) or "none"
    recent = "\n".join(f"- {m}" for m in inbound[:10])
    return (
        "Summarise what the user owes this person in one sentence of at most 140 "
        "characters, in the second person. Do not quote them. Mention a specific only "
        f"if it appears in this list: {allowed}.\n"
        f"Thread state: {state}\n"
        f"Their recent messages:\n{recent}\n\nSentence:"
    )


def select_producer(model_id: str | None = None) -> tuple[GistProducer, str | None]:
    """The one place the SQL/model decision is made.

    Returns the producer and, when it degraded, the reason. Degrading is normal — Intel
    Macs, low disk, a failed download — so it is a return value rather than an
    exception. CONTRACTS.md § 6: degrade, never fabricate.
    """
    model_id = model_id if model_id is not None else os.environ.get(MODEL_ENV_VAR, "")
    model_id = (model_id or "").strip()
    if not model_id:
        return SqlGistProducer(), None

    candidate = LocalModelGistProducer(model_id=model_id)
    if candidate.available():
        return candidate, None
    return SqlGistProducer(), candidate.unavailable_reason()


# --------------------------------------------------------------------------- build


def stats_from_digest_relationship(
    relationship: dict,
    facts: dict | None = None,
) -> ThreadStats:
    """AMENDMENT-001. A `ThreadStats` built from a `digest.v1` relationship.

    **Additive.** `build_gists(db_path, …)` below is untouched and stays the tested path
    a Mac-side producer will use if the port ever happens; deleting it to "simplify"
    would throw that away.

    The mapping is deliberately total — every field `classify`, `priority` and
    `sql_gist_text` read comes from the digest, and nothing is invented:

    - `momentum` is a property over `messages_last_90d / messages_prior_90d`, and
      `momentum_90d` already carries exactly that ratio. Rather than fabricate two
      window counts, set the prior window to a fixed 1 and the recent window to the
      ratio, which reproduces the property exactly.
    - `recent_inbound_text` stays **empty**, always. It is the other person's prose, it
      never leaves the Mac, and `facts` crossing instead is the whole point of the
      amendment. A digest-driven producer runs without it.
    - `handle` is the `contact_id`. The producer only uses `handle` to derive a
      `contact_id`, and here it is already derived — on the Mac, under the user's salt.
    """
    facts = facts if facts is not None else relationship.get("facts") or {}
    momentum = float(relationship.get("momentum_90d", 1.0))
    total = int(relationship.get("message_count", 0))
    sent = int(relationship.get("sent_count", 0))

    return ThreadStats(
        handle=relationship["contact_id"],
        total_messages=total,
        sent_messages=sent,
        received_messages=int(relationship.get("received_count", total - sent)),
        days_silent=int(relationship.get("days_since_last_contact", 0)),
        last_from_me=bool(relationship["last_from_me"]),
        unanswered_question=bool(relationship["unanswered_question"]),
        max_gap_days=int(relationship["max_gap_days"]),
        median_reply_latency_seconds=(relationship.get("median_reply_latency_s") or {}).get("them"),
        # The property is recent/prior; 1.0 prior makes recent the ratio itself.
        messages_last_90d=momentum,
        messages_prior_90d=1.0,
        recent_inbound_text=[],
        facts=_facts_with_all_keys(facts),
    )


def _facts_with_all_keys(facts: dict) -> dict:
    """Five keys, always, so downstream reads need no `.get` dance."""
    return {k: list(facts.get(k) or []) for k in ("dates", "times", "places", "amounts", "names")}


def gists_from_digest(
    digest: dict,
    top: int | None = None,
    as_of: str | None = None,
    producer: GistProducer | None = None,
) -> list[dict]:
    """Ranked gists from a `digest.v1` document. The cloud-side entry point.

    Mirrors `build_gists`' ordering and degradation exactly: `classify` returning `None`
    omits the thread, ties break on `contact_id`, and a `ModelUnavailable` falls back to
    the SQL producer rather than dropping the item.
    """
    as_of = as_of or digest.get("generated_at") or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    # THE DIGEST PATH REFUSES A MODEL PRODUCER, rather than trusting a gate that cannot
    # bite. AMENDMENT-001 sets `recent_inbound_text=[]` here and is right to — the digest
    # carries metadata, never prose — so a `LocalModelGistProducer` is asked to summarise
    # nothing. `_quotes_the_corpus` now fails closed on an empty corpus, which means a
    # model producer here would silently degrade to the SQL sentence on every single
    # thread. Saying so out loud beats a fallback that looks like it worked.
    #
    # Latent today only because no MLX backend is installed, which is exactly why testing
    # would not have found it.
    if producer is not None and getattr(producer, "producer", "sql") != "sql":
        raise ModelProducerNotAvailableOnDigestPath(
            f"{type(producer).__name__} needs message text; digest.v1 carries none. "
            "Gist production from a digest is SQL-only."
        )
    if producer is None:
        producer = SqlGistProducer()

    gists: list[dict] = []
    for relationship in sorted(digest.get("relationships", []), key=lambda r: r["contact_id"]):
        if relationship.get("is_group"):
            continue
        stats = stats_from_digest_relationship(relationship)
        state = classify(stats)
        if state is None:
            continue
        cid = relationship["contact_id"]
        try:
            gists.append(producer.produce(cid, stats, state, as_of))
        except ModelUnavailable:
            gists.append(SqlGistProducer().produce(cid, stats, state, as_of))

    gists.sort(key=lambda g: (-g["priority"], g["contact_id"]))
    return gists[:top] if top else gists


def build_gists(
    db_path: str,
    top: int | None = None,
    salt: bytes | None = None,
    as_of: str | None = None,
    now_epoch: int | None = None,
    producer: GistProducer | None = None,
) -> list[dict]:
    """Ranked gists for every thread that needs one, highest priority first.

    Threads `classify` returns `None` for are omitted entirely — a healthy thread has
    no gist. Ties break on `contact_id` so the ordering is total and stable.
    """
    salt = salt if salt is not None else resolve_salt()
    as_of = as_of or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    if producer is None:
        producer, _ = select_producer()

    con = chatdb.connect(db_path)
    try:
        threads = load_threads(con, now_epoch=now_epoch)
    finally:
        con.close()

    gists: list[dict] = []
    for handle in sorted(threads):
        stats = threads[handle]
        state = classify(stats)
        if state is None:
            continue
        cid = chatdb.contact_id(handle, salt)
        try:
            gists.append(producer.produce(cid, stats, state, as_of))
        except ModelUnavailable:
            gists.append(SqlGistProducer().produce(cid, stats, state, as_of))

    gists.sort(key=lambda g: (-g["priority"], g["contact_id"]))
    return gists[:top] if top else gists


def write_gists(gists: list[dict], out_dir: str) -> list[pathlib.Path]:
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for g in gists:
        path = out / f"gist_{g['contact_id']}.json"
        path.write_text(json.dumps(g, indent=2, ensure_ascii=False) + "\n")
        written.append(path)
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m boi_intel.gist",
        description="Produce gist.v1 documents from a chat.db. SQL by default.",
    )
    # AMENDMENT-001. Exactly one source. `--digest` is the cloud path and reads a
    # stored `digest.v1`; `--db` is the Mac path and is unchanged. Mutually exclusive
    # and required, so "which one did it use?" is never a question.
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--db", help="path to a Messages chat.db, read-only")
    src.add_argument("--digest", help="path to a digest.v1 document (no corpus needed)")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--top", type=int, default=None, help="keep only the N highest priority")
    ap.add_argument("--salt", default=None, help="user_salt for the contact_id HMAC")
    ap.add_argument("--as-of", dest="as_of", default=None, help="ISO 8601 UTC timestamp")
    a = ap.parse_args(argv)

    chosen, reason = select_producer()
    if reason:
        # Structured JSON to stdout, per CONTRACTS.md § 6. Never the prompt, never text.
        print(json.dumps({"event": "gist.producer_degraded", "to": "sql", "reason": reason}))

    if a.digest:
        # Not `chosen`: on a machine where a local model IS installed, handing it to the
        # digest path is the bug above. The refusal lives in `gists_from_digest` so a
        # library caller hits it too; this is the CLI declining to walk into it.
        if getattr(chosen, "producer", "sql") != "sql":
            print(
                json.dumps(
                    {
                        "event": "gist.model_producer_refused",
                        "path": "digest",
                        "reason": "digest.v1 carries no message text for a model to summarise",
                    }
                )
            )
        digest = json.loads(pathlib.Path(a.digest).read_text())
        gists = gists_from_digest(digest, top=a.top, as_of=a.as_of, producer=None)
    else:
        gists = build_gists(
            a.db, top=a.top, salt=resolve_salt(a.salt), as_of=a.as_of, producer=chosen
        )
    for path in write_gists(gists, a.out):
        g = json.loads(path.read_text())
        print(f"{path}  {g['state']}  priority={g['priority']}  producer={g['producer']}")
    if not gists:
        print(json.dumps({"event": "gist.none_needed"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
