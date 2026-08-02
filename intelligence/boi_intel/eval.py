"""The eval harness — a model bake-off decided on evidence, not benchmarks.

    python -m boi_intel.eval --db /tmp/boi-b/chat.db --models fake --n 20

Ground truth is free (see `evalset`), so this scores every draft against the message the
user *actually sent* at that moment. It re-runs for nothing on every prompt change and
it needs no human raters.

Four things here are deliberate:

- **`oracle` is a row.** It replays the user's real reply through the same pipeline. Its
  register-match must come out at 1.0 — that is the metric checking itself — and its
  **validator pass rate is the most interesting number in the table**, because it says
  how often the gates would refuse a real human message. A gate that rejects the user's
  own writing is not strict, it is wrong.
- **`fake` is the determinism control**, not a quality baseline. `FakeProvider` replays
  four recordings keyed to fixture `gist_id`s, so on corpus-derived cases it answers
  none of them. That is reported as `no_recording`, never hidden.
- **A model that cannot be reached is a row marked SKIPPED with the reason.** Silently
  omitting it is how a bake-off quietly becomes a single-model report.
- **Spend is capped** by `--max-calls` before any provider is constructed.

Nothing here changes a gate to improve a score. That is scoring your own exam.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import statistics
import sys
import time
from collections import Counter
from dataclasses import dataclass, field

from boi_intel.draft import draft
from boi_intel.evalset import EvalCase, build_cases
from boi_intel.providers.fake import FakeProvider
from boi_intel.providers.gemini import GeminiProvider, LiveCallsDisabled
from boi_intel.providers.kimi import KimiProvider
from boi_intel.register import EMOJI

DEFAULT_MODELS = ("oracle", "fake")
REVIEW_PAIRS = 20
HELD_OUT_PAIRS = 50

# Chars per token, for the estimate used when a provider reports no usage metadata.
CHARS_PER_TOKEN = 4.0

# USD per 1,000,000 tokens. `source` is recorded because an unsourced price silently
# becomes a fact, and this table is the input to a spend decision.
PRICING: dict[str, dict] = {
    "gemini-3.1-flash-lite": {"in": 0.25, "out": 1.50, "source": "user-provided, 2 Aug"},
    "gemini-3.5-flash-lite": {
        "in": 0.25,
        "out": 1.50,
        "source": "ASSUMED same as 3.1-flash-lite — not confirmed",
    },
    "gemini-2.5-flash-lite": {"in": 0.10, "out": 0.40, "source": "ASSUMED — model is retired"},
}


@dataclass
class CaseResult:
    case_id: str
    passed: bool
    failures: list[str]
    register_match: bool
    length_delta: int | None
    latency_ms: int
    input_tokens: int
    output_tokens: int
    answered: bool
    candidates: list[dict] = field(default_factory=list)
    actual_reply: str = ""


@dataclass
class ModelResult:
    model: str
    skipped_reason: str | None = None
    cases: list[CaseResult] = field(default_factory=list)

    @property
    def answered(self) -> list[CaseResult]:
        return [c for c in self.cases if c.answered]

    def summary(self) -> dict:
        if self.skipped_reason:
            return {"model": self.model, "skipped": self.skipped_reason}

        n = len(self.cases)
        answered = self.answered
        deltas = [c.length_delta for c in answered if c.length_delta is not None]
        latencies = [c.latency_ms for c in self.cases]
        in_tok = sum(c.input_tokens for c in self.cases)
        out_tok = sum(c.output_tokens for c in self.cases)

        price = PRICING.get(self.model)
        cost = (in_tok / 1e6) * price["in"] + (out_tok / 1e6) * price["out"] if price else None

        return {
            "model": self.model,
            "cases": n,
            "answered": len(answered),
            "no_recording": n - len(answered),
            "register_match_rate": (
                sum(1 for c in answered if c.register_match) / len(answered) if answered else None
            ),
            "median_len_delta": statistics.median(deltas) if deltas else None,
            "validator_pass_rate": sum(1 for c in self.cases if c.passed) / n if n else None,
            "p50_latency_ms": statistics.median(latencies) if latencies else None,
            "input_tokens": in_tok,
            "output_tokens": out_tok,
            "cost_usd": cost,
            "cost_per_draft_usd": (cost / n) if cost is not None and n else None,
            "price_source": price["source"] if price else "no price configured",
            # Which gate is doing the rejecting. A pass rate alone says a model is
            # worse; this says whether it is too long, too formal, or inventing things
            # — three different fixes, and only one of them is "pick another model".
            "failure_counts": dict(
                sorted(Counter(f for c in self.cases for f in c.failures).items())
            ),
        }


# ----------------------------------------------------------------- eval providers


class OracleProvider:
    """Replays the message the user actually sent, through the whole pipeline.

    Not a model and not in the router — it is an eval instrument. It exists to
    calibrate: the register metric must score it 1.0 (it is comparing the reply to
    itself), and its validator pass rate measures how often the gates would refuse a
    real human message.

    The same text is emitted under both stances. That is not a real choice and is not
    meant to be; the row answers "how does ground truth score", not "is this a good
    draft pair".
    """

    model_id = "oracle"

    def __init__(self, reply: str = "") -> None:
        self.reply = reply
        self.last_usage = {"input_tokens": 0, "output_tokens": 0}

    def complete(self, system: str, cached_prefix: str, suffix: str) -> str:
        return json.dumps(
            {
                "candidates": [
                    {"stance": "answer", "text": self.reply},
                    {"stance": "defer", "text": self.reply},
                ]
            }
        )


class Timed:
    """Measures the provider call itself, closest to the wire.

    Wrapped INSIDE the throttle on purpose. Timing the outer wrapper would fold this
    harness's own rate-limit sleeping into `p50_latency_ms` and report a 1-second model
    as a 7-second one — a number about our pacing masquerading as a number about the
    model, in the table that picks the model.
    """

    def __init__(self, inner) -> None:
        self.inner = inner
        self.elapsed_ms = 0

    @property
    def model_id(self) -> str:
        return self.inner.model_id

    @property
    def last_usage(self):
        return getattr(self.inner, "last_usage", None)

    def reset(self) -> None:
        self.elapsed_ms = 0

    def complete(self, system: str, cached_prefix: str, suffix: str) -> str:
        started = time.monotonic()
        try:
            return self.inner.complete(system, cached_prefix, suffix)
        finally:
            self.elapsed_ms += int((time.monotonic() - started) * 1000)


class CallCapped:
    """Wraps a provider and refuses past `max_calls`. The spend cap, enforced at the
    only place a call can happen."""

    def __init__(self, inner, max_calls: int) -> None:
        self.inner = inner
        self.max_calls = max_calls
        self.calls = 0

    @property
    def model_id(self) -> str:
        return self.inner.model_id

    @property
    def last_usage(self):
        return getattr(self.inner, "last_usage", None)

    def complete(self, system: str, cached_prefix: str, suffix: str) -> str:
        if self.calls >= self.max_calls:
            raise CallCapExceeded(f"--max-calls={self.max_calls} reached")
        self.calls += 1
        return self.inner.complete(system, cached_prefix, suffix)


class CallCapExceeded(RuntimeError):
    """The harness stopped itself before spending more."""


def _retry_after_seconds(message: str) -> float | None:
    """Pull Gemini's own "Please retry in 996.514435ms" hint out of a 429 body."""
    m = re.search(r"retry in ([\d.]+)(ms|s)\b", message)
    if not m:
        return None
    value = float(m.group(1))
    return value / 1000.0 if m.group(2) == "ms" else value


class Throttled:
    """Paces calls and retries a 429, so a per-minute quota is a delay not a dead row.

    This lives in the harness rather than in `GeminiProvider` on purpose. A production
    drafter that silently retries is hiding a capacity problem from the morning brief;
    a bake-off that abandons a whole model row on one 429 reports "SKIPPED" for a model
    that works perfectly well, which is worse — it would have settled the comparison on
    an artifact of request pacing.
    """

    def __init__(self, inner, rpm: int, max_retries: int = 6, sleep=time.sleep) -> None:
        self.inner = inner
        self.min_interval = 60.0 / rpm if rpm > 0 else 0.0
        self.max_retries = max_retries
        self._sleep = sleep
        self._last_call = 0.0
        self.retries = 0

    @property
    def model_id(self) -> str:
        return self.inner.model_id

    @property
    def last_usage(self):
        return getattr(self.inner, "last_usage", None)

    def complete(self, system: str, cached_prefix: str, suffix: str) -> str:
        delay = 2.0
        for attempt in range(self.max_retries + 1):
            gap = time.monotonic() - self._last_call
            if gap < self.min_interval:
                self._sleep(self.min_interval - gap)
            self._last_call = time.monotonic()
            try:
                return self.inner.complete(system, cached_prefix, suffix)
            except Exception as exc:  # noqa: BLE001
                if "429" not in str(exc) or attempt == self.max_retries:
                    raise
                self.retries += 1
                # The API states its own retry delay. Preferring it over a guessed
                # backoff is the difference between waiting the right second and
                # waiting sixteen.
                self._sleep(max(_retry_after_seconds(str(exc)) or 0.0, delay))
                delay *= 2
        raise RuntimeError("unreachable")


def build_provider(model: str):
    """A provider for one matrix row, or a `LiveCallsDisabled` explaining the skip.

    Nothing here makes a network call — construction is free, so the whole matrix can be
    validated before a byte is sent.
    """
    if model == "oracle":
        return OracleProvider()
    if model == "fake":
        return FakeProvider()
    if model.startswith("gemini"):
        p = GeminiProvider(model=model)
        p.preflight()
        return p
    if model.startswith("kimi"):
        p = KimiProvider(model=model)
        p.preflight()
        return p
    raise LiveCallsDisabled(f"unknown model {model!r}")


# ------------------------------------------------------------------------ scoring


def surface_register(text: str) -> tuple[bool, bool, bool]:
    """The three things people notice instantly: case, terminal full stop, emoji."""
    stripped = (text or "").strip()
    first = next((c for c in stripped if c.isalpha()), None)
    return (
        bool(first and first.islower()),
        stripped.endswith("."),
        bool(EMOJI.search(stripped)),
    )


def register_matches(candidate: str, actual: str) -> bool:
    return surface_register(candidate) == surface_register(actual)


def score_case(case: EvalCase, bundle, latency_ms: int, usage: dict | None) -> CaseResult:
    candidates = [{"stance": c.stance, "text": c.text} for c in bundle.candidates]
    answered = bool(candidates)

    if usage:
        in_tok, out_tok = usage.get("input_tokens", 0), usage.get("output_tokens", 0)
    else:
        in_tok = out_tok = 0

    # Best-of-two on register, because in the product the user picks one of the two.
    register_match = any(register_matches(c["text"], case.actual_reply) for c in candidates)
    deltas = [len(c["text"]) - len(case.actual_reply) for c in candidates]

    return CaseResult(
        case_id=case.case_id,
        passed=bundle.validator.passed,
        failures=list(bundle.validator.failures),
        register_match=register_match,
        length_delta=int(statistics.median(deltas)) if deltas else None,
        latency_ms=latency_ms,
        input_tokens=in_tok,
        output_tokens=out_tok,
        answered=answered,
        candidates=candidates,
        actual_reply=case.actual_reply,
    )


def _estimate_usage(case: EvalCase, bundle) -> dict:
    """Character-based fallback when a provider reports no usage metadata."""
    from boi_intel.prompts import SYSTEM, render_gist, render_voice_pack

    prompt_chars = (
        len(SYSTEM) + len(render_voice_pack(case.voice_pack)) + len(render_gist(case.gist))
    )
    out_chars = sum(len(c.text) for c in bundle.candidates)
    return {
        "input_tokens": int(prompt_chars / CHARS_PER_TOKEN),
        "output_tokens": int(out_chars / CHARS_PER_TOKEN),
    }


def run_model(model: str, cases: list[EvalCase], max_calls: int, rpm: int = 0) -> ModelResult:
    try:
        base = build_provider(model)
    except LiveCallsDisabled as exc:
        # A model that cannot be reached is a ROW, marked skipped, with the reason.
        return ModelResult(model=model, skipped_reason=str(exc))
    except Exception as exc:  # noqa: BLE001 - any construction failure is a skip
        return ModelResult(model=model, skipped_reason=f"{type(exc).__name__}: {exc}")

    result = ModelResult(model=model)
    timed = Timed(base)
    paced = (
        Throttled(timed, rpm)
        if rpm and not isinstance(base, OracleProvider | FakeProvider)
        else timed
    )
    capped = CallCapped(paced, max_calls)

    for case in cases:
        if isinstance(base, OracleProvider):
            base.reply = case.actual_reply
        timed.reset()
        try:
            bundle = draft(
                case.voice_pack,
                case.gist,
                provider=capped,
                as_of="2026-08-01T00:00:00Z",
            )
        except CallCapExceeded:
            break
        except LookupError:
            # FakeProvider has no recording for this gist_id. Reported, not hidden.
            result.cases.append(
                CaseResult(
                    case_id=case.case_id,
                    passed=False,
                    failures=["empty"],
                    register_match=False,
                    length_delta=None,
                    latency_ms=timed.elapsed_ms,
                    input_tokens=0,
                    output_tokens=0,
                    answered=False,
                    actual_reply=case.actual_reply,
                )
            )
            continue
        except Exception as exc:  # noqa: BLE001
            result.skipped_reason = f"{type(exc).__name__}: {exc}"
            return result

        # Model time only — see `Timed`. Throttle sleep is this harness's cost, not
        # the model's, and must not reach the comparison table.
        latency = timed.elapsed_ms
        usage = getattr(capped, "last_usage", None) or _estimate_usage(case, bundle)
        result.cases.append(score_case(case, bundle, latency, usage))

    return result


# ------------------------------------------------------------------------- output


def _fmt(value, spec: str = "", dash: str = "—") -> str:
    if value is None:
        return dash
    return format(value, spec) if spec else str(value)


def render_table(results: list[ModelResult]) -> str:
    header = (
        f"{'model':<24} {'cases':>5} {'ans':>4} {'reg':>7} {'Δlen':>6} "
        f"{'pass':>6} {'p50ms':>7} {'tok in/out':>14} {'$/draft':>10}"
    )
    lines = [header, "-" * len(header)]
    for r in results:
        s = r.summary()
        if "skipped" in s:
            lines.append(f"{r.model:<24} {'SKIPPED':>5}  — {s['skipped'][:70]}")
            continue
        lines.append(
            f"{s['model']:<24} {s['cases']:>5} {s['answered']:>4} "
            f"{_fmt(s['register_match_rate'], '.0%'):>7} "
            f"{_fmt(s['median_len_delta'], '+.0f'):>6} "
            f"{_fmt(s['validator_pass_rate'], '.0%'):>6} "
            f"{_fmt(s['p50_latency_ms'], '.0f'):>7} "
            f"{s['input_tokens']:>6}/{s['output_tokens']:<7} "
            f"{_fmt(s['cost_per_draft_usd'], '.6f'):>10}"
        )
    lines.append("")
    lines.append("reg  = register match vs the real reply (case, terminal period, emoji),")
    lines.append("       best of the two candidates — the user picks one.")
    lines.append("Δlen = median (draft length - real reply length), in characters.")
    lines.append("pass = validator pass rate over ALL cases, degraded ones included.")
    lines.append("ans  = cases the provider actually answered; the rest had no recording.")
    return "\n".join(lines)


def write_review_file(
    results: list[ModelResult], cases: list[EvalCase], path: pathlib.Path, pairs: int = REVIEW_PAIRS
) -> pathlib.Path:
    """The send / edit / delete file. Plain text, readable with no tooling.

    This is the drafting analogue of the report-card kill test, and it is the thing that
    decides whether the feature ships. **This harness does not answer it** — it only
    puts the question in front of a human in a form they can answer in ten minutes.
    """
    by_id = {c.case_id: c for c in cases}
    labels = {cid: f"Person {i + 1}" for i, cid in enumerate(sorted({c.contact_id for c in cases}))}

    live = [r for r in results if not r.skipped_reason and r.answered]
    chosen = max(live, key=lambda r: len(r.answered)) if live else None

    out = [
        "BOI DRAFT REVIEW",
        "=" * 72,
        "",
        "For each pair, mark ONE box per candidate:",
        "  [s] send as-is    [e] would edit first    [d] delete, would not send",
        "",
        "The question is not 'is this well written'. It is: would you press send?",
        f"model: {chosen.model if chosen else 'none — no model answered'}",
        "=" * 72,
        "",
    ]

    if chosen is None:
        out.append("No model produced candidates, so there is nothing to review.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(out) + "\n")
        return path

    for i, result in enumerate(chosen.answered[:pairs], start=1):
        case = by_id.get(result.case_id)
        who = labels.get(case.contact_id, "Person ?") if case else "Person ?"
        out.append(f"--- {i:02d}. {who}   (state: {case.gist['state'] if case else '?'})")
        out.append(f"    situation: {case.gist['gist'] if case else ''}")
        out.append("")
        for c in result.candidates:
            out.append(f"    [{c['stance']}]  {c['text']}")
            out.append("        [ ] send    [ ] edit    [ ] delete")
        out.append("")
        out.append(f"    (what they actually sent: {result.actual_reply})")
        out.append("")

    out += [
        "=" * 72,
        "TALLY",
        f"  send:   ___ / {2 * min(pairs, len(chosen.answered))}",
        "  edit:   ___",
        "  delete: ___",
        "",
        "Ship criterion is send+edit, not send alone: an edited draft still saved the",
        "user the blank page, which is the thing they were avoiding.",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n")
    return path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m boi_intel.eval",
        description="Score drafts against what the user actually sent.",
    )
    ap.add_argument("--db", required=True, help="a chat.db to build the eval set from")
    ap.add_argument(
        "--models",
        default=",".join(DEFAULT_MODELS),
        help="comma-separated matrix rows, e.g. oracle,fake,gemini-3.5-flash-lite",
    )
    ap.add_argument("--n", type=int, default=20, help="number of eval cases")
    ap.add_argument("--max-calls", type=int, default=200, help="hard cap on provider calls")
    ap.add_argument(
        "--rpm", type=int, default=12, help="live-model requests per minute; 0 disables pacing"
    )
    ap.add_argument("--out", default="/tmp/boi-b/out/eval", help="directory for artifacts")
    ap.add_argument("--review-pairs", type=int, default=REVIEW_PAIRS)
    a = ap.parse_args(argv)

    cases = build_cases(a.db, limit=a.n)
    if not cases:
        print("no eval cases: no thread has an inbound run the user later answered")
        return 1

    models = [m.strip() for m in a.models.split(",") if m.strip()]
    results = [run_model(m, cases, a.max_calls, a.rpm) for m in models]

    out_dir = pathlib.Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    table = render_table(results)
    print(f"\n{len(cases)} eval cases from {a.db}\n")
    print(table)

    (out_dir / "table.txt").write_text(table + "\n")
    (out_dir / "summary.json").write_text(
        json.dumps([r.summary() for r in results], indent=2, sort_keys=True) + "\n"
    )
    review = write_review_file(results, cases, out_dir / "review.txt", a.review_pairs)
    print(f"\nartifacts: {out_dir}/table.txt, summary.json, {review.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
