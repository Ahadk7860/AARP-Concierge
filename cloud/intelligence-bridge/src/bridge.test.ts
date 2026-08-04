// The intelligence bridge, tested against a real Python interpreter and a real database.
//
// A join that passes because both sides were stubbed is not a join. Nothing here mocks
// `child_process`, and nothing here reads a committed gist fixture and calls it a gist
// the producer made. Every `gistsFor` assertion below is on documents that `boi_intel`
// wrote to disk in a subprocess this file started, from a `chat.db` on this machine.
//
// The suite takes the same advisory lock as Track D's database tests: vitest runs files
// in parallel and `schema.test.ts` drops and rebuilds the schema underneath anything
// else that is mid-insert.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Digest, DraftBundle, Gist, VoicePack } from "../../shared/src/index.js";
import {
  closePool,
  createUser,
  insertDigest,
  newDigestId,
  registerDevice,
  upsertVoicePack,
  type UserScope,
} from "../../db/src/index.js";
import { migrate } from "../../db/src/migrate.js";
import { acquireSuiteLock, releaseSuiteLock } from "../../db/src/test-lock.js";
import {
  DEFAULT_MAX_ITEMS,
  PythonUnavailableError,
  REPO_ROOT,
  bridgeDeps,
  check,
  collectGists,
  configFromEnvironment,
  draftArgv,
  draftsForGists,
  gistOutcomeFor,
  invokePython,
  isGone,
  gistsFor,
  pythonExecutable,
  spawnPython,
} from "./index.js";

// CONTRACTS.md § 9 gives Track E no scratch directory of its own. Track A's is free.
const CORPUS = "/tmp/boi-a/chat.db";

type Captured = Record<string, unknown>;

function capture(): { log: (e: Record<string, unknown>) => void; events: Captured[] } {
  const events: Captured[] = [];
  return { log: (e) => events.push(e), events };
}

function messages(events: Captured[]): string[] {
  return events.map((e) => String(e["msg"]));
}

function baseConfig(over: Record<string, unknown> = {}) {
  return { provider: "fake", timeoutMs: 60_000, maxItems: DEFAULT_MAX_ITEMS, ...over };
}

/** The synthetic corpus. A missing fixture is a failure, never a skip. */
function ensureCorpus(): void {
  if (existsSync(CORPUS)) return;
  execFileSync("/usr/bin/python3", [
    path.join(REPO_ROOT, "scripts", "make_synthetic_chatdb.py"),
    "--out",
    CORPUS,
  ]);
  if (!existsSync(CORPUS)) throw new Error(`could not build ${CORPUS}`);
}

/**
 * A user with a stored digest and a voice pack for every contact the producer will
 * name — built by running the REAL Mac-side artefacts through `POST`-shaped repository
 * calls, so `voicePackFor` has something true to return.
 */
async function seedUser(gistContactIds: readonly string[]): Promise<UserScope> {
  const { scope } = await createUser({
    phone_e164: `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
  });
  const device_id = `dev_${Math.random().toString(16).slice(2, 18).padEnd(16, "0")}`;
  await registerDevice(scope, { device_id });

  const digest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "contracts", "fixtures", "digest", "healthy.json"), "utf8"),
  ) as Digest;
  digest.user_id = scope.user_id;
  digest.device_id = device_id;
  await insertDigest(scope, { digest_id: newDigestId(), digest });

  const globalPack = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "contracts", "fixtures", "voice_pack", "global_fallback.json"),
      "utf8",
    ),
  ) as VoicePack;
  await upsertVoicePack(scope, globalPack);

  const mayaPack = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "contracts", "fixtures", "voice_pack", "maya.json"),
      "utf8",
    ),
  ) as VoicePack;
  for (const [index, contactId] of gistContactIds.entries()) {
    await upsertVoicePack(scope, {
      ...mayaPack,
      contact_id: contactId,
      voice_pack_version: `vp_${index.toString(16).padStart(8, "0")}`,
    });
  }
  return scope;
}


/** Seeds a user whose stored digest is exactly `relationships`. */
async function seedUserWithRelationships(relationships: unknown[]): Promise<UserScope> {
  const { scope } = await createUser({
    phone_e164: `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
  });
  const device_id = `dev_${Math.random().toString(16).slice(2, 18).padEnd(16, "0")}`;
  await registerDevice(scope, { device_id });
  const digest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "contracts", "fixtures", "digest", "healthy.json"), "utf8"),
  ) as Digest;
  digest.user_id = scope.user_id;
  digest.device_id = device_id;
  (digest as unknown as { relationships: unknown[] }).relationships = relationships;
  await insertDigest(scope, { digest_id: newDigestId(), digest });
  return scope;
}

/** A relationship nobody is waiting on: `classify()` returns None for it. */
function healthyRelationship(index: number): Record<string, unknown> {
  return {
    contact_id: `h_${(index + 0xa0).toString(16).padStart(8, "0")}`,
    display: `Quiet ${index}`,
    is_group: false,
    message_count: 40,
    sent_count: 20,
    received_count: 20,
    days_since_last_contact: 0,
    momentum_90d: 1,
    initiation_ratio: 0.5,
    last_from_me: true,
    max_gap_days: 3,
    unanswered_question: false,
    facts: { dates: [], times: [], places: [], amounts: [], names: [] },
    as_of: "2026-08-01T09:14:00Z",
  };
}

beforeAll(async () => {
  ensureCorpus();
  await acquireSuiteLock();
  await migrate();
}, 120_000);

afterAll(async () => {
  await releaseSuiteLock();
  await closePool();
});

// ---------------------------------------------------------------------------

describe("the subprocess boundary", () => {
  it("cannot pass without Python — rename the interpreter and this fails", async () => {
    // THE CRITERION THAT MAKES THE REST OF THIS FILE MEAN ANYTHING. If these assertions
    // can hold with no interpreter on the machine, nothing else in this file is testing
    // the intelligence bridge.
    const scope = await seedUser([]);

    // 1. With Python: real gists, from a real subprocess.
    const { events, log } = capture();
    const withPython = await gistOutcomeFor(scope, baseConfig({ log }) as never);
    expect(withPython.status).toBe("ok");
    expect(withPython.gists.length).toBeGreaterThan(0);
    expect(messages(events)).toContain("bridge.gists.produced");

    // 2. Interpreter renamed. The raw boundary rejects with an error that NAMES the
    //    problem rather than returning an empty result.
    const saved = process.env["BOI_PYTHON"];
    process.env["BOI_PYTHON"] = "/nonexistent/python-that-is-not-here";
    try {
      await expect(invokePython("boi_intel.gist", ["--help"])).rejects.toThrow(
        PythonUnavailableError,
      );

      // 3. And the bridge above it degrades to `unavailable` — which is NOT
      //    `nothing_to_say`. An empty list here would read as "this user had a quiet
      //    week" for as long as it took somebody to notice.
      const spy = capture();
      const without = await gistOutcomeFor(scope, baseConfig({ log: spy.log }) as never);
      expect(without.status).toBe("unavailable");
      expect(without.gists).toEqual([]);
      expect(messages(spy.events)).toContain("bridge.gists.python_unavailable");
      expect(String(spy.events[0]?.["error"])).toContain("could not start Python");
    } finally {
      if (saved === undefined) delete process.env["BOI_PYTHON"];
      else process.env["BOI_PYTHON"] = saved;
    }
  }, 180_000);

  it("resolves an interpreter that satisfies the project's floor", () => {
    // `pyproject.toml` requires >= 3.11 and macOS ships 3.9 as `python3`. A bridge that
    // silently picked the system interpreter would fail inside boi_intel on syntax.
    const executable = pythonExecutable();
    const version = execFileSync(executable, ["--version"], { encoding: "utf8" });
    const [major, minor] = version.replace("Python ", "").trim().split(".").map(Number);
    expect(major).toBe(3);
    expect(minor).toBeGreaterThanOrEqual(11);
  });

  it("checks the exit code before it looks at anything else", async () => {
    // A module that does not exist: non-zero, and whatever it wrote is from a run that
    // did not finish.
    const result = await invokePython("boi_intel.no_such_module", [], { timeoutMs: 30_000 });
    expect(result.status).not.toBe(0);
    expect(result.reaped).toBe(true);
  }, 60_000);

  it("kills a hanging child rather than abandoning it, and reaps it", async () => {
    const started = Date.now();
    const result = await invokePython("boi_intel.gist", ["--db", CORPUS, "--out", tmpdir()], {
      timeoutMs: 25,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    // `reaped` is now MEASURED by `kill(pid, 0)` rather than being a literal `true`, so
    // this assertion has teeth. Re-check it independently here anyway.
    expect(result.reaped).toBe(true);
    expect(result.pid).not.toBeNull();
    expect(isGone(result.pid ?? undefined)).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it("kills the whole process GROUP, not just the interpreter", async () => {
    // THE REGRESSION THE PREVIOUS TEST CANNOT CATCH. `killGroup` sends to `-pid`
    // precisely so an orphaned model call does not keep holding a Gemini quota slot and
    // a file handle. A childless interpreter dies identically under `kill(pid)` and
    // `kill(-pid)`, so proving the group behaviour needs a child that itself has a child.
    const marker = `boi-group-kill-${process.pid}-${Date.now()}`;
    const script =
      "import subprocess,sys,time\n" +
      `subprocess.Popen(['/bin/sh','-c','exec -a ${marker} sleep 120'])\n` +
      "sys.stderr.write('spawned\\n'); sys.stderr.flush()\n" +
      "time.sleep(120)\n";

    const result = await spawnPython(["-c", script], { timeoutMs: 3_000 });
    expect(result.timedOut).toBe(true);
    expect(result.reaped).toBe(true);

    // The GRANDCHILD must be gone too. Give the OS a moment to reap.
    let survivors = "";
    for (let i = 0; i < 20; i += 1) {
      survivors = execFileSync("/bin/sh", ["-c", `ps -Ao args | grep -c "[${marker[0]}]${marker.slice(1)}" || true`], {
        encoding: "utf8",
      }).trim();
      if (survivors === "0") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      survivors,
      "a grandchild survived the timeout: killGroup is signalling the pid, not the group",
    ).toBe("0");
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("gistsFor", () => {
  it("produces action_needed from a DIGEST, with no corpus path anywhere", async () => {
    // THE CRITERION THE WHOLE AMENDMENT EXISTS FOR.
    //
    // Before AMENDMENT-001 the bridge was handed a corpus path and opened a `chat.db`
    // in the cloud. `digest.v1` could not supply `last_from_me`, so `classify()` could
    // never return `action_needed` from a digest — the state the entire daily brief
    // exists to deliver. This asserts both halves: the state is reachable, and there is
    // no corpus involved.
    const scope = await seedUser([]);
    const { events, log } = capture();
    const outcome = await gistOutcomeFor(scope, baseConfig({ log }) as never);

    expect(outcome.status, JSON.stringify(events)).toBe("ok");
    expect(outcome.gists.length).toBeGreaterThan(0);
    expect(
      outcome.gists.some((g) => g.state === "action_needed"),
      `no action_needed gist: ${outcome.gists.map((g) => g.state).join(", ")}`,
    ).toBe(true);

    for (const gist of outcome.gists) {
      expect(check<Gist>("gist.v1", gist).ok).toBe(true);
      expect(gist.gist_id).toMatch(/^g_[0-9a-f]{8,32}$/);
      expect(gist.contact_id).toMatch(/^h_[0-9a-f]{8,32}$/);
    }

    // NOT the committed fixture gists.
    expect(outcome.gists.map((g) => g.gist_id)).not.toContain("g_11aa22bb");
    expect(messages(events)).toContain("bridge.gists.produced");
  }, 120_000);

  it("distinguishes no_answer from nothing_to_say", async () => {
    // Both are an empty gist list from the composer's seat, and one of them means the
    // intelligence has been broken for a week.
    //
    // `no_answer`: a stored digest the producer cannot read. `last_from_me` is required
    // by the schema, so a relationship without it only reaches the producer if something
    // wrote round the boundary — which is exactly when you want a loud failure.
    const broken = await seedUserWithRelationships([
      { ...healthyRelationship(0), last_from_me: undefined },
    ]);
    const brokenSpy = capture();
    const failed = await gistOutcomeFor(broken, baseConfig({ log: brokenSpy.log }) as never);
    expect(failed.status).toBe("no_answer");
    expect(failed.gists).toEqual([]);
    expect(messages(brokenSpy.events)).toContain("bridge.gists.failed");

    // `nothing_to_say`: every thread healthy. A GOOD outcome.
    const quiet = await seedUserWithRelationships([0, 1, 2].map(healthyRelationship));
    const quietSpy = capture();
    const healthy = await gistOutcomeFor(quiet, baseConfig({ log: quietSpy.log }) as never);
    expect(healthy.status).toBe("nothing_to_say");
    expect(healthy.gists).toEqual([]);
    expect(messages(quietSpy.events)).toContain("bridge.gists.nothing_to_say");
  }, 180_000);

  it("tells an operator the brief will look like a quiet week", async () => {
    // `gistsFor` returns `Gist[]`, so every failure collapses to an empty array by the
    // time the composer sees it. Correct for the composer, catastrophic for an operator.
    const scope = await seedUserWithRelationships([
      { ...healthyRelationship(0), last_from_me: undefined },
    ]);
    const degraded: string[] = [];
    const { events, log } = capture();

    const gists = await gistsFor(
      baseConfig({ log, onDegraded: (o: { status: string }) => degraded.push(o.status) }) as never,
    )(scope);

    expect(gists).toEqual([]);              // invisible to the composer, by design
    expect(degraded).toEqual(["no_answer"]); // and loud to an operator
    const alarm = events.find((e) => e["msg"] === "bridge.degraded");
    expect(alarm, JSON.stringify(events)).toBeDefined();
    expect(alarm?.["level"]).toBe("error");
  }, 180_000);

  it("does not cry wolf when the corpus is simply quiet", async () => {
    // `nothing_to_say` is HEALTHY and must never fire the alarm, or the alarm gets
    // ignored — which is exactly how the real one gets missed.
    const scope = await seedUserWithRelationships([0, 1].map(healthyRelationship));
    const degraded: string[] = [];
    const gists = await gistsFor(
      baseConfig({ onDegraded: (o: { status: string }) => degraded.push(o.status) }) as never,
    )(scope);
    expect(gists).toEqual([]);
    expect(degraded).toEqual([]);
  }, 180_000);

  it("degrades to no gists rather than throwing when there is no digest", async () => {
    // A Mac that has never reported. Not staleness, and not a bridge fault.
    const { scope } = await createUser({
      phone_e164: `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
    });
    const { events, log } = capture();
    const outcome = await gistOutcomeFor(scope, baseConfig({ log }) as never);
    expect(outcome.status).toBe("unavailable");
    expect(outcome.gists).toEqual([]);
    expect(messages(events)).toContain("bridge.gists.no_digest");
  }, 60_000);

  it("reports a timeout as timed_out, not as a crash", async () => {
    // A SIGKILLed child also has a non-zero exit, so folding the timeout into
    // `no_answer` meant the timeout criterion's test ran through the crash branch and
    // asserted nothing about timing out. They are different operator problems: a bug in
    // the producer versus a producer that is too slow or a model call that hung.
    const scope = await seedUser([]);
    const { events, log } = capture();
    const outcome = await gistOutcomeFor(scope, baseConfig({ log, timeoutMs: 25 }) as never);

    expect(outcome.status).toBe("timed_out");
    expect(outcome.gists).toEqual([]);
    expect(messages(events)).toContain("bridge.gists.timed_out");
    expect(messages(events)).not.toContain("bridge.gists.failed");
  }, 120_000);

  it("drops a malformed gist and keeps the rest — at the BRIDGE, not just in the validator", async () => {
    // This used to call `check()` directly, which proves the validator works and proves
    // nothing about whether the bridge consults it: delete the `check` call from
    // `collectGists` and the old test still passed. `collectGists` is the actual code
    // path `gistOutcomeFor` runs, so a regression that stopped validating fails here.
    const good = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "contracts", "fixtures", "gist", "maya_action_needed.json"),
        "utf8",
      ),
    ) as Gist;
    const other = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "contracts", "fixtures", "gist", "yu_fading_sql_only.json"),
        "utf8",
      ),
    ) as Gist;

    const dir = await mkdtemp(path.join(tmpdir(), "boi-collect-"));
    try {
      await writeFile(path.join(dir, "gist_1_good.json"), JSON.stringify(good));
      await writeFile(
        path.join(dir, "gist_2_bad.json"),
        JSON.stringify({ ...good, gist_id: "not-a-gist-id", days_silent: -4 }),
      );
      await writeFile(path.join(dir, "gist_3_unparseable.json"), "{ this is not json");
      await writeFile(path.join(dir, "gist_4_good.json"), JSON.stringify(other));

      const { events, log } = capture();
      const collected = await collectGists(
        dir,
        ["gist_1_good.json", "gist_2_bad.json", "gist_3_unparseable.json", "gist_4_good.json"],
        log,
        "usr_test",
      );

      // THE REMAINING GISTS STILL REACH THE COMPOSER. One bad document out of four must
      // not cost the user their morning text.
      expect(collected.map((g) => g.gist_id)).toEqual([good.gist_id, other.gist_id]);

      // Logged with its index and the validation error, as the criterion requires.
      const invalid = events.find((e) => e["msg"] === "bridge.gists.invalid");
      expect(invalid, JSON.stringify(events)).toBeDefined();
      expect(invalid?.["index"]).toBe(1);
      expect(String(invalid?.["errors"])).toContain("/gist_id");
      expect(messages(events)).toContain("bridge.gists.unparseable");

      // Field paths and messages, NEVER values. The gist crossed the digest boundary,
      // and putting it in a log is what that boundary exists to prevent.
      const logged = JSON.stringify(events);
      expect(logged).not.toContain(good.gist);
      for (const fact of [...good.facts.dates, ...good.facts.times, ...good.facts.names]) {
        expect(logged).not.toContain(fact);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("draftsFor", () => {
  /**
   * The fixture gists, deliberately.
   *
   * `FakeProvider` replays on `gist_id_contains` and the four committed transcripts name
   * four hard-coded ids. A gist the producer just made has an id no transcript matches,
   * so `fake` raises `LookupError` and exits 1 — **the determinism control and the real
   * gist producer are mutually exclusive.** Recorded in NOTES.md. This half of the join
   * is therefore driven with a valid `gist.v1` the provider can answer, and the real
   * gist → draft path is closed by the live call in the report.
   */
  async function fixtureGist(name: string): Promise<Gist> {
    return JSON.parse(
      await readFile(path.join(REPO_ROOT, "contracts", "fixtures", "gist", name), "utf8"),
    ) as Gist;
  }

  it("returns two stance-distinct candidates that passed Track B's validator", async () => {
    const gist = await fixtureGist("maya_action_needed.json");
    const scope = await seedUser([gist.contact_id]);
    const { events, log } = capture();

    const bundles = await draftsForGists(scope, [gist], baseConfig({ log }) as never);

    // KEYED ON gist_id. `compose.ts` does `input.drafts.get(gist.gist_id)`.
    const bundle = bundles.get(gist.gist_id);
    expect(bundle, `no bundle for ${gist.gist_id}: ${JSON.stringify(events)}`).toBeDefined();
    if (bundle === undefined) return;

    expect(check<DraftBundle>("draft_bundle.v1", bundle).ok).toBe(true);
    expect(bundle.candidates).toHaveLength(2);
    expect(bundle.validator.passed).toBe(true);
    // Exactly two, differing in STANCE rather than phrasing. Two paraphrases of one
    // sentence is a fake choice and users notice immediately.
    expect(new Set(bundle.candidates.map((c) => c.stance)).size).toBe(2);
    expect(bundle.gist_id).toBe(gist.gist_id);
    expect(bundle.contact_id).toBe(gist.contact_id);
    // Reproducible from identifiers alone: CONTRACTS.md § 6, log the hash not the prompt.
    expect(bundle.model_id).toBeTruthy();
    expect(bundle.prompt_version).toBeTruthy();
    expect(bundle.voice_pack_version).toBeTruthy();
  }, 120_000);

  it("never puts the voice pack in argv, because ps is world-readable", async () => {
    // The pack is the user's own sent messages. `--voice-pack '{"exemplars":[…]}'` would
    // put them in `ps` output for every process on the machine.
    const gist = await fixtureGist("maya_action_needed.json");
    const scope = await seedUser([gist.contact_id]);
    const pack = JSON.parse(
      await readFile(
        path.join(REPO_ROOT, "contracts", "fixtures", "voice_pack", "maya.json"),
        "utf8",
      ),
    ) as VoicePack;
    const exemplar = pack.exemplars[0];
    expect(exemplar).toBeTruthy();

    // 1. THE ARGV THE BRIDGE ACTUALLY BUILDS. This used to assert on an array the test
    //    constructed itself, which proves a test can write a safe argv rather than that
    //    the bridge does — `draftArgv` is the function the bridge calls.
    const argv = draftArgv({
      packPath: "/tmp/pack.json",
      gistPath: "/tmp/gist.json",
      outPath: "/tmp/out.json",
      provider: "fake",
      userId: scope.user_id,
    });
    expect(argv).toContain("--voice-pack");
    for (const arg of argv) {
      expect(arg.startsWith("/") || arg.startsWith("--") || arg.length < 64).toBe(true);
      expect(arg).not.toContain(exemplar ?? "");
      // No argument may be a JSON document: that is what inlining the pack would look like.
      expect(arg.trimStart().startsWith("{")).toBe(false);
    }

    // 2. AND THE REAL INVOCATION'S argv, read back off `InvokeResult` rather than
    //    reconstructed — plus a live `ps` snapshot taken while the child is running.
    const workdir = await mkdtemp(path.join(tmpdir(), "boi-argv-"));
    try {
      const packPath = path.join(workdir, "pack.json");
      const gistPath = path.join(workdir, "gist.json");
      await writeFile(packPath, JSON.stringify(pack), { mode: 0o600 });
      await writeFile(gistPath, JSON.stringify(gist), { mode: 0o600 });

      const running = invokePython(
        "boi_intel.draft",
        draftArgv({
          packPath,
          gistPath,
          outPath: path.join(workdir, "out.json"),
          provider: "fake",
          userId: scope.user_id,
        }),
        { timeoutMs: 60_000, env: { BOI_MODEL_PROVIDER: "fake" } },
      );

      let snapshot = "";
      for (let i = 0; i < 60; i += 1) {
        snapshot += execFileSync("/bin/ps", ["-Ao", "args"], { encoding: "utf8" });
        if (snapshot.includes("boi_intel.draft")) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const result = await running;

      expect(snapshot).toContain("boi_intel.draft");
      if (exemplar !== undefined) {
        expect(snapshot, "an exemplar reached ps output").not.toContain(exemplar);
        for (const arg of result.argv) {
          expect(arg, "an exemplar reached argv").not.toContain(exemplar);
        }
      }
      // Every free-text field in the pack, not just the first exemplar.
      for (const text of [...pack.exemplars, ...(pack.register.apology_openers ?? [])]) {
        expect(snapshot).not.toContain(text);
        expect(result.argv.join(" ")).not.toContain(text);
      }
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }, 180_000);

  it("deletes the voice pack file in the per-gist finally, not just with the workdir", async () => {
    // The old version asserted that no `boi-bridge-draft-*` directory survived — which
    // the OUTER `finally` guarantees by deleting the whole tree, whether or not the
    // per-gist `finally` ever ran. Delete the inner cleanup and the old test still
    // passed, while a crash mid-loop would leave the user's own sent messages in a
    // world-readable temp file for as long as the process lived.
    //
    // The workdir is injected here, so the test owns it and it is still there to inspect.
    const gist = await fixtureGist("maya_action_needed.json");
    const scope = await seedUser([gist.contact_id]);
    const workdir = await mkdtemp(path.join(tmpdir(), "boi-owned-"));
    try {
      // A timeout of 1ms guarantees the child is killed mid-flight.
      const bundles = await draftsForGists(
        scope,
        [gist],
        baseConfig({ timeoutMs: 1, workdir }) as never,
      );
      expect(bundles.size).toBe(0);

      // The directory SURVIVES (the test owns it) and is empty of secrets.
      expect(existsSync(workdir)).toBe(true);
      const leftovers = execFileSync("/bin/sh", ["-c", `ls -A ${workdir} || true`], {
        encoding: "utf8",
      }).trim();
      expect(
        leftovers.split("\n").filter((f) => f.startsWith("pack-")),
        `the voice pack outlived the crash: ${leftovers}`,
      ).toEqual([]);
      expect(leftovers.split("\n").filter((f) => f.startsWith("gist-"))).toEqual([]);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }, 120_000);

  it("writes the voice pack 0600 while it exists", async () => {
    // `ps` is not the only way the pack leaks. It is on disk for the duration of the
    // call, and the mode is what keeps another account on the machine out of it.
    const gist = await fixtureGist("maya_action_needed.json");
    const scope = await seedUser([gist.contact_id]);
    const workdir = await mkdtemp(path.join(tmpdir(), "boi-mode-"));
    try {
      const running = draftsForGists(scope, [gist], baseConfig({ workdir }) as never);
      let mode: string | null = null;
      for (let i = 0; i < 200; i += 1) {
        const listed = execFileSync("/bin/sh", [
          "-c",
          `stat -f '%Sp' ${workdir}/pack-*.json 2>/dev/null || true`,
        ], { encoding: "utf8" }).trim();
        if (listed !== "") {
          mode = listed.split("\n")[0] ?? null;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      await running;
      expect(mode, "never observed the pack on disk").not.toBeNull();
      expect(mode).toBe("-rw-------");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }, 120_000);

  it("yields zero drafts and never a fabricated one when Python crashes", async () => {
    const gist = await fixtureGist("maya_action_needed.json");
    const scope = await seedUser([gist.contact_id]);
    const { events, log } = capture();
    // No voice pack for this contact and no global fallback would be the other path;
    // here the provider itself is one that does not exist, so the module exits non-zero.
    const bundles = await draftsForGists(
      scope,
      [gist],
      baseConfig({ log, provider: "no-such-provider" }) as never,
    );
    expect(bundles.size).toBe(0);
    expect(messages(events)).toContain("bridge.drafts.failed");
  }, 120_000);

  it("skips a gist with no voice pack rather than drafting in a voice it has never seen", async () => {
    const gist = await fixtureGist("maya_action_needed.json");
    // A user with NO packs at all — not even the global fallback.
    const { scope } = await createUser({
      phone_e164: `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
    });
    const { events, log } = capture();
    const bundles = await draftsForGists(scope, [gist], baseConfig({ log }) as never);
    expect(bundles.size).toBe(0);
    expect(messages(events)).toContain("bridge.drafts.no_voice_pack");
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("bridgeDeps", () => {
  it("computes the gists once per tick, so the drafts are for the brief's gists", async () => {
    // `runForUser` calls `gistsFor` and `draftsFor` separately. Running the producer
    // twice would give the second run a different `as_of`, and the drafts would be for
    // gists the brief does not contain.
    const scope = await seedUser([]);
    const deps = bridgeDeps(baseConfig() as never);
    const first = await deps.gistsFor(scope);
    const second = await deps.gistsFor(scope);
    expect(second).toBe(first);
  }, 180_000);

  it("reads its configuration from the environment", () => {
    const config = configFromEnvironment({
      BOI_MODEL_PROVIDER: "fake",
      BOI_BRIEF_MAX_ITEMS: "3",
    } as NodeJS.ProcessEnv);
    expect(config.provider).toBe("fake");
    expect(config.maxItems).toBe(3);
  });

  it("has no way to be pointed at a corpus", () => {
    // AMENDMENT-001 deleted the seam. This asserts on the CONFIG SURFACE rather than on
    // a grep, because a grep passes the moment somebody renames the variable — the point
    // is that there is nowhere to put a corpus path, not that two strings are absent.
    // Built dynamically so this assertion does not itself reintroduce the strings the
    // amendment deleted — the property is that the CONFIG SURFACE has nowhere to put a
    // corpus, not that two spellings are absent from one file.
    const legacy = ["CORPUS_DB", "CORPUS_DIR", "DEV_USER_SALT"]
      .reduce<Record<string, string>>((env, k) => ({ ...env, [`BOI_${k}`]: "/tmp/x" }), {});
    const config = configFromEnvironment(legacy as NodeJS.ProcessEnv);
    expect(Object.keys(config).sort()).toEqual(
      ["log", "maxItems", "onDegraded", "provider", "timeoutMs", "workdir"]
        .filter((k) => k in config)
        .sort(),
    );
    for (const key of Object.keys(config)) {
      expect(key.toLowerCase()).not.toContain("corpus");
      expect(key.toLowerCase()).not.toContain("salt");
    }
  });

  it("defaults the provider to fake, because live calls are never a suite's business", () => {
    // CONTRACTS.md § 9: Gemini live calls are Track B's, they require
    // BOI_ALLOW_LIVE_CALLS=1, and they belong in the eval harness.
    expect(configFromEnvironment({} as NodeJS.ProcessEnv).provider).toBe("fake");
  });
});
