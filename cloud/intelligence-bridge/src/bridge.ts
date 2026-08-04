// `gistsFor` and `draftsFor`, backed by real invocations of `boi_intel`.
//
// The hole this fills, quoted from `cloud/brief/src/run.ts` before this file existed:
//
//     /** Track B produces these. Supplied per user; this track consumes fixtures. */
//     gistsFor: (scope: UserScope) => Promise<Gist[]>;
//
// AMENDMENT-001 removed the seam this file used to open with.
//
// The gist producer needs `last_from_me`, `max_gap_days`, `unanswered_question` and
// `facts`, and `digest.v1` did not carry them — so the bridge was handed a corpus path
// and read a `chat.db` from the cloud, which is the one thing the design forbids. The
// digest carries all four now. `boi_intel.gist.gists_from_digest` reads the stored
// document and the corpus never leaves the Mac.
//
// `build_gists(db_path, …)` is untouched and still the tested path a Mac-side producer
// would use if the local-model port ever happens.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DraftBundle, Gist, VoicePack } from "../../shared/src/index.js";
import { latestDigest, voicePackFor, type UserScope } from "../../db/src/index.js";
import {
  DEFAULT_TIMEOUT_MS,
  PythonUnavailableError,
  describeFailure,
  invokePython,
  lastStderrLine,
  type InvokeResult,
} from "./invoke.js";
import { check } from "./validate.js";

export type BridgeLog = (event: Record<string, unknown>) => void;

export type BridgeConfig = {
  /** `fake` in CI. CONTRACTS.md § 9: live calls are Track B's, and never in a suite. */
  provider?: string | undefined;
  timeoutMs?: number | undefined;
  /** Capped the same way the brief is. Three a day is a habit; twenty is noise. */
  maxItems?: number | undefined;
  log?: BridgeLog | undefined;
  /**
   * **The channel degradation escapes through.**
   *
   * `gistsFor` returns `Gist[]`, so every failure state — Python missing, the producer
   * crashing, a timeout — collapses into an empty array by the time the composer sees
   * it, and the user gets a brief that reads as a quiet week. That degradation is
   * correct for the *composer* (it must not know why) and catastrophic for an
   * *operator*, who otherwise learns the intelligence has been down only when somebody
   * complains.
   *
   * Fired for every status in `DEGRADED_STATUSES` and never for `nothing_to_say`.
   */
  onDegraded?: ((outcome: GistOutcome, scope: UserScope) => void) | undefined;
  /** Overridable so a test can inspect what the child was handed and what survived it. */
  workdir?: string | undefined;
};

export const DEFAULT_MAX_ITEMS = 3;

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    provider: env["BOI_MODEL_PROVIDER"] ?? "fake",
    timeoutMs: env["BOI_INTEL_TIMEOUT_MS"] ? Number(env["BOI_INTEL_TIMEOUT_MS"]) : undefined,
    maxItems: env["BOI_BRIEF_MAX_ITEMS"] ? Number(env["BOI_BRIEF_MAX_ITEMS"]) : undefined,
  };
}

/**
 * Why a run produced nothing, and the distinction prompt `02` singles out.
 *
 * `nothing_to_say` is a healthy corpus with no thread that needs anything — the common
 * case, and the reason `classify()` returns `None` for most threads. `no_answer` is a
 * producer that ran and told us nothing, which looks identical from the brief's seat and
 * is a completely different problem. Collapsing them is how "this user had a quiet week"
 * silently becomes "the intelligence has been broken for a week".
 */
export type GistOutcome =
  | { status: "ok"; gists: Gist[] }
  | { status: "nothing_to_say"; gists: [] }
  | { status: "no_answer"; gists: []; detail: string }
  | { status: "timed_out"; gists: []; detail: string }
  | { status: "unavailable"; gists: []; detail: string };

/**
 * The states that mean **the intelligence is broken**, as opposed to quiet.
 *
 * `nothing_to_say` is a healthy corpus. Everything else here is an operator's problem,
 * and it is invisible from the composer's seat because all of them render as an empty
 * gist list — which is why the degradation needs its own channel out.
 */
export const DEGRADED_STATUSES = ["no_answer", "timed_out", "unavailable"] as const;

export function isDegraded(outcome: GistOutcome): boolean {
  return (DEGRADED_STATUSES as readonly string[]).includes(outcome.status);
}

// ---------------------------------------------------------------------------
// Gists
// ---------------------------------------------------------------------------

export async function gistOutcomeFor(
  scope: UserScope,
  config: BridgeConfig = configFromEnvironment(),
): Promise<GistOutcome> {
  const log = config.log ?? (() => {});

  // THE DIGEST IS THE INPUT NOW. It used to be read only as a gate — "has this Mac ever
  // reported?" — while the gists came from a corpus the cloud should never have had.
  const digest = await latestDigest(scope);
  if (digest === null) {
    log({ msg: "bridge.gists.no_digest", user_id: scope.user_id });
    return { status: "unavailable", gists: [], detail: "no digest stored" };
  }

  const workdir = await mkdtemp(path.join(tmpdir(), "boi-bridge-"));
  try {
    // The digest goes to the child as a 0600 file, never on argv. It is smaller than a
    // voice pack and carries no prose, but `facts` is content-derived and argv is
    // world-readable on macOS.
    // INPUT AND OUTPUT IN SEPARATE DIRECTORIES. Writing the digest into the directory
    // the producer writes gists to made it come back as a `*.json` on the read side and
    // get dropped as a malformed gist — which turned "this user is fine" into
    // `no_answer`, the exact confusion the two statuses exist to prevent.
    const outDir = path.join(workdir, "out");
    await mkdir(outDir, { recursive: true });
    const digestPath = path.join(workdir, "digest.json");
    await writeFile(digestPath, JSON.stringify(digest.payload), { mode: 0o600 });
    const args = ["--digest", digestPath, "--out", outDir,
                  "--top", String(config.maxItems ?? DEFAULT_MAX_ITEMS)];

    let result: InvokeResult;
    try {
      result = await invokePython("boi_intel.gist", args, {
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: { BOI_MODEL_PROVIDER: config.provider ?? "fake" },
      });
    } catch (err) {
      if (err instanceof PythonUnavailableError) {
        // No interpreter is not "this user had a quiet week". It is the bridge being
        // down, and it says so — loudly, and without a fabricated empty result.
        log({ msg: "bridge.gists.python_unavailable", user_id: scope.user_id, error: err.message });
        return { status: "unavailable", gists: [], detail: err.message };
      }
      throw err;
    }

    // EXIT CODE FIRST. A crash that happened to leave a readable file behind is still a
    // crash, and the files it left are from a run that did not finish.
    //
    // A TIMEOUT IS ITS OWN STATUS. It also has a non-zero exit — the child was SIGKILLed
    // — so folding it into `no_answer` made the timeout criterion's test pass through the
    // crash branch and assert nothing about timing out. They are different operator
    // problems: one is a bug in the producer, the other is a producer that is too slow or
    // a model call that hung.
    if (result.timedOut) {
      log({
        msg: "bridge.gists.timed_out",
        user_id: scope.user_id,
        timeout_ms: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        duration_ms: result.durationMs,
        reaped: result.reaped,
      });
      return {
        status: "timed_out",
        gists: [],
        detail: `killed after ${result.durationMs}ms`,
      };
    }
    if (result.status !== 0) {
      log({
        msg: "bridge.gists.failed",
        user_id: scope.user_id,
        failure: describeFailure(result),
        stderr_tail: lastStderrLine(result),
        duration_ms: result.durationMs,
      });
      return { status: "no_answer", gists: [], detail: describeFailure(result) };
    }

    const files = (await readdir(outDir)).filter((f) => f.endsWith(".json")).sort();
    if (files.length === 0) {
      // A zero exit with no output. `gist.py` prints `gist.none_needed` in exactly one
      // situation — every thread classified as `None`, which is a healthy corpus.
      const nothing = result.stdout.includes("gist.none_needed");
      log({
        msg: nothing ? "bridge.gists.nothing_to_say" : "bridge.gists.no_answer",
        user_id: scope.user_id,
        duration_ms: result.durationMs,
      });
      return nothing
        ? { status: "nothing_to_say", gists: [] }
        : { status: "no_answer", gists: [], detail: "zero exit, no documents written" };
    }

    const gists = await collectGists(outDir, files, log, scope.user_id);

    if (gists.length === 0) {
      return { status: "no_answer", gists: [], detail: `${files.length} document(s), none valid` };
    }

    // The producer already sorts by priority; re-sorting here would be a second opinion
    // about ranking, which is Track B's and not this bridge's.
    const capped = gists.slice(0, config.maxItems ?? DEFAULT_MAX_ITEMS);
    log({
      msg: "bridge.gists.produced",
      user_id: scope.user_id,
      count: capped.length,
      dropped: files.length - gists.length,
      duration_ms: result.durationMs,
    });
    return { status: "ok", gists: capped };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/**
 * Reads and validates what the producer wrote. **This is the bridge boundary.**
 *
 * Extracted so it can be tested against documents the producer would never write. It
 * used to be inline, which meant the only test of boundary validation called `check()`
 * directly — proving the validator works and proving nothing about whether the bridge
 * consults it. A regression that dropped the `check` call entirely would have passed.
 */
export async function collectGists(
  directory: string,
  files: readonly string[],
  log: BridgeLog,
  userId: string,
): Promise<Gist[]> {
  const gists: Gist[] = [];
  for (const [index, file] of files.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(directory, file), "utf8"));
    } catch {
      log({ msg: "bridge.gists.unparseable", user_id: userId, index, file });
      continue;
    }
    // A MALFORMED GIST IS A DROPPED GIST. The remaining ones still reach the composer:
    // one bad document out of three must not cost the user their morning text.
    const validated = check<Gist>("gist.v1", parsed);
    if (!validated.ok) {
      log({
        msg: "bridge.gists.invalid",
        user_id: userId,
        index,
        file,
        errors: validated.errors,
      });
      continue;
    }
    gists.push(validated.value);
  }
  return gists;
}

/**
 * The `TickDeps.gistsFor` shape. Degradation is invisible to the composer by design —
 * and **visible to an operator via `onDegraded`**, which is the difference between a
 * quiet week and a bridge that has been down since Tuesday.
 */
export function gistsFor(
  config: BridgeConfig = configFromEnvironment(),
): (scope: UserScope) => Promise<Gist[]> {
  return async (scope) => {
    const outcome = await gistOutcomeFor(scope, config);
    reportDegradation(outcome, scope, config);
    return outcome.gists;
  };
}

/** Fires `onDegraded`, and logs at error level whether or not one is configured. */
function reportDegradation(
  outcome: GistOutcome,
  scope: UserScope,
  config: BridgeConfig,
): void {
  if (!isDegraded(outcome)) return;
  const log = config.log ?? (() => {});
  log({
    msg: "bridge.degraded",
    level: "error",
    user_id: scope.user_id,
    status: outcome.status,
    detail: "detail" in outcome ? outcome.detail : undefined,
    // Said plainly, because the log line is the only thing that distinguishes this from
    // a user who genuinely had a quiet week.
    consequence: "the brief will render as though there were nothing to say",
  });
  config.onDegraded?.(outcome, scope);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/**
 * Two candidates per gist, keyed by `gist_id`.
 *
 * **Keyed by `gist_id`, not `contact_id`.** Prompt `02` says `Map<contact_id,
 * DraftBundle>`; `compose.ts` does `input.drafts.get(gist.gist_id)`. The composer wins —
 * it is merged, tested code, and this track adapts rather than edits. Recorded in
 * NOTES.md.
 *
 * Every failure here yields **fewer or no drafts, never a fabricated one and never a
 * failed brief**. A brief with no draft is fine; a brief with a bad draft is a trust
 * event, and a brief that did not arrive is worse than both.
 */
export async function draftsForGists(
  scope: UserScope,
  gists: readonly Gist[],
  config: BridgeConfig = configFromEnvironment(),
): Promise<Map<string, DraftBundle>> {
  const log = config.log ?? (() => {});
  const bundles = new Map<string, DraftBundle>();
  if (gists.length === 0) return bundles;

  // Injectable so a test can inspect what survived a crash. When the bridge makes its
  // own, the bridge removes it; when a caller supplies one, the caller owns it — which
  // is what lets the "pack deleted even when the child crashes" assertion be about the
  // per-gist `finally` rather than about the outer one that deletes the whole tree.
  const ownsWorkdir = config.workdir === undefined;
  const workdir = config.workdir ?? (await mkdtemp(path.join(tmpdir(), "boi-bridge-draft-")));
  await mkdir(workdir, { recursive: true });
  try {
    for (const gist of gists) {
      const packRow = await voicePackFor(scope, gist.contact_id);
      if (packRow === null) {
        // No pack, contact-scoped or global. Drafting in a voice we have no examples of
        // is the fabrication this whole design exists to avoid.
        log({ msg: "bridge.drafts.no_voice_pack", user_id: scope.user_id, gist_id: gist.gist_id });
        continue;
      }
      const pack = packRow.payload as VoicePack;

      const packPath = path.join(workdir, `pack-${gist.gist_id}.json`);
      const gistPath = path.join(workdir, `gist-${gist.gist_id}.json`);
      const outPath = path.join(workdir, `bundle-${gist.gist_id}.json`);
      try {
        // THE VOICE PACK IS THE USER'S OWN SENT MESSAGES. It goes to the child as a
        // `0600` file, never on the command line — argv is world-readable on macOS, so
        // `--voice-pack '{"exemplars":[…]}'` would put the user's messages in `ps`. The
        // path is on argv; the content never is.
        await writeFile(packPath, JSON.stringify(pack), { mode: 0o600 });
        await writeFile(gistPath, JSON.stringify(gist), { mode: 0o600 });

        const result = await invokePython(
          "boi_intel.draft",
          draftArgv({
            packPath,
            gistPath,
            outPath,
            provider: config.provider ?? "fake",
            userId: scope.user_id,
          }),
          {
            timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            env: { BOI_MODEL_PROVIDER: config.provider ?? "fake" },
          },
        );

        if (result.status !== 0) {
          log({
            msg: "bridge.drafts.failed",
            user_id: scope.user_id,
            gist_id: gist.gist_id,
            failure: describeFailure(result),
            stderr_tail: lastStderrLine(result),
          });
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(outPath, "utf8"));
        } catch {
          log({ msg: "bridge.drafts.no_answer", user_id: scope.user_id, gist_id: gist.gist_id });
          continue;
        }

        const validated = check<DraftBundle>("draft_bundle.v1", parsed);
        if (!validated.ok) {
          log({
            msg: "bridge.drafts.invalid",
            user_id: scope.user_id,
            gist_id: gist.gist_id,
            errors: validated.errors,
          });
          continue;
        }

        const bundle = validated.value;
        // A degraded bundle — zero candidates after the validator refused both twice —
        // is a legitimate outcome and it is carried through rather than dropped, so the
        // composer can tell "no drafts" from "no bundle". `compose.ts` renders both as
        // no drafts, and the difference is visible in the log.
        bundles.set(bundle.gist_id, bundle);
        log({
          msg: "bridge.drafts.produced",
          user_id: scope.user_id,
          gist_id: bundle.gist_id,
          candidates: bundle.candidates.length,
          model_id: bundle.model_id,
          prompt_version: bundle.prompt_version,
          voice_pack_version: bundle.voice_pack_version,
          validator_passed: bundle.validator.passed,
          attempts: bundle.validator.attempts,
        });
      } catch (err) {
        if (err instanceof PythonUnavailableError) {
          // No interpreter means no drafts for anybody. Stop rather than repeating the
          // same failure once per gist.
          log({
            msg: "bridge.drafts.python_unavailable",
            user_id: scope.user_id,
            error: err.message,
          });
          break;
        }
        throw err;
      } finally {
        // The pack held the user's own sent messages. It does not outlive the call, and
        // the `finally` is what makes that true when the child crashes.
        await Promise.all([
          rm(packPath, { force: true }),
          rm(gistPath, { force: true }),
        ]);
      }
    }
    return bundles;
  } finally {
    if (ownsWorkdir) await rm(workdir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The pair, as `TickDeps` wants them
// ---------------------------------------------------------------------------

/**
 * `gistsFor` and `draftsFor` sharing one gist computation per tick.
 *
 * `runForUser` calls them separately, and running the producer twice would be both slow
 * and wrong — the second run's `as_of` differs, so the drafts would be for gists the
 * brief does not contain. The gists are computed once, memoized per scope, and the
 * memo does not outlive the tick.
 */
export function bridgeDeps(config: BridgeConfig = configFromEnvironment()): {
  gistsFor: (scope: UserScope) => Promise<Gist[]>;
  draftsFor: (scope: UserScope) => Promise<Map<string, DraftBundle>>;
} {
  const inFlight = new Map<string, Promise<GistOutcome>>();
  const outcome = (scope: UserScope): Promise<GistOutcome> => {
    const existing = inFlight.get(scope.user_id);
    if (existing !== undefined) return existing;
    const promise = gistOutcomeFor(scope, config).then((result) => {
      // Reported once per tick, here rather than in `gistsFor`, because the outcome is
      // memoized and an operator should not get the same alarm twice for one brief.
      reportDegradation(result, scope, config);
      return result;
    });
    inFlight.set(scope.user_id, promise);
    return promise;
  };
  return {
    gistsFor: async (scope) => (await outcome(scope)).gists,
    draftsFor: async (scope) => draftsForGists(scope, (await outcome(scope)).gists, config),
  };
}

/**
 * The child's argv, built where a test can see it.
 *
 * The voice pack is the user's own sent messages, and `argv` is world-readable on macOS
 * — `--voice-pack '{"exemplars":[…]}'` would put them in `ps` output for every process
 * on the machine. Only PATHS go here.
 *
 * Extracted because the assertion that used to guard this was written against an array
 * the test built itself, which proves the test can construct a safe argv rather than
 * that the bridge does.
 */
export function draftArgv(input: {
  packPath: string;
  gistPath: string;
  outPath: string;
  provider: string;
  userId: string;
}): string[] {
  return [
    "--voice-pack", input.packPath,
    "--gist", input.gistPath,
    // `--out`, because stdout carries BOTH the `draft.produced` log line and the
    // bundle. Parsing a stream something else shares is the trap.
    "--out", input.outPath,
    "--provider", input.provider,
    "--user-id", input.userId,
  ];
}

