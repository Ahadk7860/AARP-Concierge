// `gistsFor` and `draftsFor`, backed by real invocations of `boi_intel`.
//
// The hole this fills, quoted from `cloud/brief/src/run.ts` before this file existed:
//
//     /** Track B produces these. Supplied per user; this track consumes fixtures. */
//     gistsFor: (scope: UserScope) => Promise<Gist[]>;
//
// ---------------------------------------------------------------------------------
// WHERE THE GIST PRODUCER ACTUALLY BELONGS, stated here because the code below looks
// wrong without it.
//
// `boi_intel.gist` reads a `chat.db`. Its only entry point is `build_gists(db_path, …)`
// and `ThreadStats` needs `last_from_me`, `unanswered_question` and `max_gap_days` —
// none of which are in `digest.v1`. Without the first two, `classify()` can never return
// `action_needed`, which is the state the entire daily brief exists to deliver.
//
// So gists cannot be produced from a stored digest, and there is no `/v1/gists` route to
// carry them from the Mac. `BOI_ARCHITECTURE.md` § 6 is explicit that T1 gists are
// generated locally and "uploaded with the daily brief" — the producer belongs on the
// Mac and the contract has no edge for its output.
//
// This bridge therefore invokes the producer against a corpus path it is *given*. That
// is a real cross-process invocation of Track B's code producing real gists, and it is
// the honest shape of the join today. It is NOT the production topology. The resolution
// is a contract amendment: gist production moves to the Mac's sync and a `/v1/gists`
// ingest route carries the result. Recorded in NOTES.md; it is the user's to make.
// ---------------------------------------------------------------------------------

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  /**
   * Where the corpus for a user lives. See the note above: this is the seam that
   * should not exist in production.
   *
   * `BOI_CORPUS_DIR/<user_id>.db` if set, else `BOI_CORPUS_DB` for a single-user dev
   * machine. Absent means **no gists**, which is a degraded brief rather than an error.
   */
  corpusDir?: string | undefined;
  corpusDb?: string | undefined;
  /** The HMAC key the Mac used, so `contact_id`s agree with the digest's. */
  salt?: string | undefined;
  /** `fake` in CI. CONTRACTS.md § 9: live calls are Track B's, and never in a suite. */
  provider?: string | undefined;
  timeoutMs?: number | undefined;
  /** Capped the same way the brief is. Three a day is a habit; twenty is noise. */
  maxItems?: number | undefined;
  log?: BridgeLog | undefined;
};

export const DEFAULT_MAX_ITEMS = 3;

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    corpusDir: env["BOI_CORPUS_DIR"],
    corpusDb: env["BOI_CORPUS_DB"],
    salt: env["BOI_DEV_USER_SALT"],
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
  | { status: "unavailable"; gists: []; detail: string };

// ---------------------------------------------------------------------------
// Gists
// ---------------------------------------------------------------------------

export async function gistOutcomeFor(
  scope: UserScope,
  config: BridgeConfig = configFromEnvironment(),
): Promise<GistOutcome> {
  const log = config.log ?? (() => {});
  const corpus = corpusPathFor(scope, config);
  if (corpus === null) {
    log({ msg: "bridge.gists.no_corpus", user_id: scope.user_id });
    return { status: "unavailable", gists: [], detail: "no corpus configured" };
  }

  // The digest is read even though the producer does not consume it, because a brief
  // about a Mac that has never reported is a brief about nothing — and `runForUser`
  // already refuses in that case. Reading it here keeps the bridge from producing gists
  // for a scope the composer will discard, and it is where `as_of` comes from.
  const digest = await latestDigest(scope);
  if (digest === null) {
    log({ msg: "bridge.gists.no_digest", user_id: scope.user_id });
    return { status: "unavailable", gists: [], detail: "no digest stored" };
  }

  const workdir = await mkdtemp(path.join(tmpdir(), "boi-bridge-"));
  try {
    const args = ["--db", corpus, "--out", workdir, "--top", String(config.maxItems ?? DEFAULT_MAX_ITEMS)];
    if (config.salt !== undefined && config.salt !== "") args.push("--salt", config.salt);

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

    const files = (await readdir(workdir)).filter((f) => f.endsWith(".json")).sort();
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

    const gists: Gist[] = [];
    for (const [index, file] of files.entries()) {
      const raw = await readFile(path.join(workdir, file), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        log({ msg: "bridge.gists.unparseable", user_id: scope.user_id, index });
        continue;
      }
      // A MALFORMED GIST IS A DROPPED GIST. The remaining ones still reach the composer:
      // one bad document out of three must not cost the user their morning text.
      const validated = check<Gist>("gist.v1", parsed);
      if (!validated.ok) {
        log({
          msg: "bridge.gists.invalid",
          user_id: scope.user_id,
          index,
          errors: validated.errors,
        });
        continue;
      }
      gists.push(validated.value);
    }

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

/** The `TickDeps.gistsFor` shape. Degradation is invisible to the composer by design. */
export function gistsFor(
  config: BridgeConfig = configFromEnvironment(),
): (scope: UserScope) => Promise<Gist[]> {
  return async (scope) => (await gistOutcomeFor(scope, config)).gists;
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

  const workdir = await mkdtemp(path.join(tmpdir(), "boi-bridge-draft-"));
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
          [
            "--voice-pack", packPath,
            "--gist", gistPath,
            // `--out`, because stdout carries BOTH the `draft.produced` log line and the
            // bundle. Parsing a stream something else shares is the trap.
            "--out", outPath,
            "--provider", config.provider ?? "fake",
            "--user-id", scope.user_id,
          ],
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
    await rm(workdir, { recursive: true, force: true });
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
    const promise = gistOutcomeFor(scope, config);
    inFlight.set(scope.user_id, promise);
    return promise;
  };
  return {
    gistsFor: async (scope) => (await outcome(scope)).gists,
    draftsFor: async (scope) => draftsForGists(scope, (await outcome(scope)).gists, config),
  };
}

function corpusPathFor(scope: UserScope, config: BridgeConfig): string | null {
  if (config.corpusDir !== undefined && config.corpusDir !== "") {
    return path.join(config.corpusDir, `${scope.user_id}.db`);
  }
  if (config.corpusDb !== undefined && config.corpusDb !== "") return config.corpusDb;
  return null;
}
