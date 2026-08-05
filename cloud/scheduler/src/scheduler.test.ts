// The scheduler, asserted where it can actually be wrong.
//
// **A scheduler is the easiest thing in this repo to write a test for that cannot fail.**
// "It called `runForUser` three times" is satisfied by a loop over a mocked list, and it
// would pass against a sweep that composed nothing, stored nothing and sent nothing. So
// nothing below counts calls. Every assertion is on **briefs in the database** and
// **messages the channel received**, on a controlled clock.
//
// The two that carry the weight are the three-mornings test and the two-instances test.
// The first is the product claim — one brief per user per morning, unsupervised. The
// second is the one whose failure is silent: `unique (user_id, scheduled_for)` already
// makes a double-send impossible, so a second scheduler is SAFE and invisible, and two
// instances running for a month look exactly like one until the day they disagree.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Digest, DraftBundle, Gist, Relationship } from "../../shared/src/index.js";
import { StubChannel } from "../../shared/src/index.js";
import {
  allUserSchedules,
  closePool,
  createUser,
  deleteUser,
  getPool,
  insertDigest,
  listBriefs,
  listOutboundMessages,
  registerDevice,
  newDeviceId,
  newDigestId,
  recordHeartbeat,
  upsertRelationships,
  type UserScope,
} from "../../db/src/index.js";
import { migrate } from "../../db/src/migrate.js";
import { acquireSuiteLock, releaseSuiteLock } from "../../db/src/test-lock.js";
import { slotFor } from "../../brief/src/scheduler.js";
import { acquireSchedulerLock } from "./lock.js";
import { fleetHealthEvent, fleetHeartbeatHealth } from "./fleet.js";
import { sweepOnce, type SweepDeps } from "./sweep.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const LA = "America/Los_Angeles";
const SYDNEY = "Australia/Sydney";

/** 08:00 local on a fixed date, as an instant. The clock is a parameter, never a sleep. */
function morning(dayOffset: number, timezone: string): Date {
  const day = new Date(Date.UTC(2026, 8, 14 + dayOffset, 12, 0, 0));
  return slotFor(day, timezone);
}

function fixture<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "contracts", "fixtures", ...parts), "utf8")) as T;
}

/**
 * An account with a digest whose `as_of` is the morning being tested.
 *
 * Freshness matters: `assessStaleness` skips the send entirely past
 * `BOI_STALENESS_SKIP_HOURS`, so a fixture digest dated last month would produce a
 * scheduler that "works" and a brief that never goes out — a test passing on the wrong
 * mechanism.
 */
async function seedUser(timezone: string, asOf: Date): Promise<UserScope> {
  const phone = `+1556${String(Math.floor(Math.random() * 9_000_000 + 1_000_000))}`;
  const { scope } = await createUser({ phone_e164: phone, timezone });

  const digest = fixture<Digest>("digest", "healthy.json");
  digest.user_id = scope.user_id;
  digest.generated_at = asOf.toISOString();
  digest.corpus.as_of = asOf.toISOString();
  await insertDigest(scope, { digest_id: newDigestId(), digest });
  await upsertRelationships(scope, digest.relationships as Relationship[]);
  return scope;
}

/** Gists for whatever the seeded digest carries, so `composeBrief` keeps every item. */
function gistsForDigest(): Gist[] {
  const digest = fixture<Digest>("digest", "healthy.json");
  return digest.relationships.slice(0, 3).map((r, index) => ({
    schema_version: "gist.v1",
    gist_id: `g_sched${index}0000`,
    contact_id: r.contact_id,
    state: "action_needed",
    days_silent: 6,
    unanswered_question: true,
    topic: null,
    has_deadline: false,
    deadline_hint: null,
    gist: "they asked you something and you have not replied",
    facts: { dates: [], times: [], places: [], amounts: [], names: [] },
    priority: 0.8 - index / 10,
    producer: "sql",
    model_id: null,
    as_of: new Date().toISOString(),
  }));
}

/**
 * Deps with the intelligence stubbed and EVERYTHING ELSE REAL.
 *
 * The gists are injected because Python is not what this prompt is about — but the
 * composer, the staleness decision, the brief row, the idempotency key, the outbound rows
 * and the channel are all the production ones. A sweep that fails to store a brief fails
 * here.
 */
function deps(channel: StubChannel, over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    channel,
    gistsFor: async () => gistsForDigest(),
    draftsFor: async () => new Map<string, DraftBundle>(),
    log: () => {},
    ...over,
  };
}

const created: UserScope[] = [];
async function user(timezone: string, asOf: Date): Promise<UserScope> {
  const scope = await seedUser(timezone, asOf);
  created.push(scope);
  return scope;
}

beforeAll(async () => {
  await acquireSuiteLock();
  await migrate();
}, 180_000);

afterEach(async () => {
  while (created.length > 0) {
    const scope = created.pop();
    if (scope !== undefined) await deleteUser(scope);
  }
});

afterAll(async () => {
  await releaseSuiteLock();
  await closePool();
});

describe("the sweep, over three simulated mornings", () => {
  it("produces exactly three briefs and three morning sends, in the database and at the channel",
    async () => {
      // THE PRODUCT CLAIM: started once, one brief per user per morning, unsupervised.
      // Asserted on rows and on messages — a version of this that counted `runForUser`
      // calls would pass against a sweep that composed nothing and sent nothing.
      const scope = await user(LA, morning(0, LA));
      const channel = new StubChannel();

      const days = [0, 1, 2];
      const statuses: string[] = [];
      for (const day of days) {
        // Three ticks per morning, five minutes apart, inside the fifteen-minute window.
        // This is the real deployment shape and the thing that makes idempotency load
        // bearing: nine ticks, three briefs.
        for (const minutes of [0, 5, 10]) {
          const at = new Date(morning(day, LA).getTime() + minutes * 60_000);
          const result = await sweepOnce(at, deps(channel));
          const mine = result.outcomes.find((o) => o.user_id === scope.user_id);
          statuses.push(mine?.status ?? "absent");
        }
      }

      // Nine ticks: three that send and six that recognise the morning is already done.
      // **This is the assertion that can actually fail**, and it is here because the
      // first version of this test could not: with `runForUser`'s idempotency
      // short-circuit deleted, the row counts below stayed at three anyway — the unique
      // constraint threw, the tick reported `failed`, and the product outcome looked
      // identical. Three briefs and six ERRORS is not the same product as three briefs
      // and six no-ops, and only this line knows the difference.
      expect(statuses, JSON.stringify(statuses)).toEqual([
        "sent", "already_sent", "already_sent",
        "sent", "already_sent", "already_sent",
        "sent", "already_sent", "already_sent",
      ]);

      const briefs = await listBriefs(scope);
      expect(briefs.length, JSON.stringify(briefs.map((b) => b.scheduled_for))).toBe(3);
      expect(new Set(briefs.map((b) => b.scheduled_for.toISOString())).size).toBe(3);
      expect(briefs.every((b) => b.delivery_status === "sent")).toBe(true);

      // One LEAD message per morning at the channel. Item messages ride behind it on a
      // threading transport, so the lead is the count that means "a morning happened".
      // Scoped to THIS user. The sweep enumerates every account in the database, which
      // is the point of it — so a count over `channel.sent` is a count over whoever else
      // happens to be in the dev database, and the test would measure leftovers.
      const leads = channel.sent.filter(
        (m) => m.user_id === scope.user_id && m.idempotency_key.endsWith("-lead"));
      expect(leads.length).toBe(3);
      expect(new Set(leads.map((m) => m.idempotency_key)).size).toBe(3);

      // And the outbox agrees with the channel, which is what a support conversation
      // reads six weeks later.
      const outbound = await listOutboundMessages(scope);
      expect(outbound.filter((r) => r.idempotency_key.endsWith("-lead")).length).toBe(3);
    }, 300_000);

  it("sends nothing at 3am, which is what makes the three above mean something", async () => {
    const scope = await user(LA, morning(0, LA));
    const channel = new StubChannel();
    const threeAm = new Date(morning(0, LA).getTime() - 5 * 3_600_000);

    const result = await sweepOnce(threeAm, deps(channel));

    expect(result.due).toBe(0);
    expect(channel.sent.filter((m) => m.user_id === scope.user_id).length).toBe(0);
    expect((await listBriefs(scope)).length).toBe(0);
  }, 300_000);
});

describe("two users, two timezones", () => {
  it("serves each at their own 08:00 and neither at the other's", async () => {
    // 8am UTC is 1am in Los Angeles and 4pm in Sydney. A brief at either is not a morning
    // brief, and the habit the product depends on is a morning habit.
    const la = await user(LA, morning(0, LA));
    const sydney = await user(SYDNEY, morning(0, SYDNEY));
    const channel = new StubChannel();

    await sweepOnce(morning(0, SYDNEY), deps(channel));
    expect((await listBriefs(sydney)).length).toBe(1);
    expect((await listBriefs(la)).length).toBe(0);

    await sweepOnce(morning(0, LA), deps(channel));
    expect((await listBriefs(la)).length).toBe(1);
    expect((await listBriefs(sydney)).length).toBe(1);

    // Each user's brief is stamped with THEIR 08:00, not the tick time.
    const [laBrief] = await listBriefs(la);
    expect(laBrief?.scheduled_for.toISOString()).toBe(morning(0, LA).toISOString());
    const [sydneyBrief] = await listBriefs(sydney);
    expect(sydneyBrief?.scheduled_for.toISOString()).toBe(morning(0, SYDNEY).toISOString());
  }, 300_000);
});

describe("one user's failure", () => {
  it("does not cost another user their morning", async () => {
    // The sweep is a loop over people. A throw on user three that took out users four
    // through four hundred would be invisible in aggregate: fewer briefs went out, and
    // nothing says why.
    const doomed = await user(LA, morning(0, LA));
    const bystander = await user(LA, morning(0, LA));
    const channel = new StubChannel();
    const events: Record<string, unknown>[] = [];

    const result = await sweepOnce(morning(0, LA), deps(channel, {
      log: (e) => events.push(e),
      gistsFor: async (scope) => {
        if (scope.user_id === doomed.user_id) throw new Error("gists exploded");
        return gistsForDigest();
      },
    }));

    expect((await listBriefs(bystander)).length).toBe(1);
    expect(channel.sent.some((m) => m.user_id === bystander.user_id)).toBe(true);

    // The failure is REPORTED rather than absorbed: a sweep that quietly delivers to
    // fewer people than are due is the same class of defect as a duplicate nobody logs.
    const mine = result.outcomes.filter(
      (o) => o.user_id === doomed.user_id || o.user_id === bystander.user_id);
    expect(mine.filter((o) => o.status === "failed").length).toBe(1);
    expect(mine.filter((o) => o.status === "sent").length).toBe(1);
    expect(events.some((e) => e["msg"] === "sweep.user_failed")).toBe(true);
  }, 300_000);
});

describe("two instances, one database", () => {
  it("sends once, and the loser LOGS the collision rather than swallowing it", async () => {
    // The database already makes this safe. That is exactly the problem: a second
    // scheduler composing the same morning loses on `unique (user_id, scheduled_for)`,
    // reports `already_sent`, and reads identically to a healthy no-op. Safe and quiet
    // are different, and a duplicate silently absorbed is a duplicate never learned.
    const scope = await user(LA, morning(0, LA));

    const first = await acquireSchedulerLock();
    expect(first.held).toBe(true);
    try {
      const second = await acquireSchedulerLock();
      // The loser does not sweep.
      expect(second.held).toBe(false);
      await second.release();

      const channel = new StubChannel();
      await sweepOnce(morning(0, LA), deps(channel));
      expect((await listBriefs(scope)).length).toBe(1);
      expect(channel.sent.filter(
        (m) => m.user_id === scope.user_id && m.idempotency_key.endsWith("-lead")).length).toBe(1);
    } finally {
      await first.release();
    }

    // And the lock is genuinely released afterwards, or the next deploy never sweeps
    // again — a failure that looks like "the product stopped working" with a green
    // process.
    const third = await acquireSchedulerLock();
    expect(third.held).toBe(true);
    await third.release();
  }, 300_000);

  it("would have sent TWICE without the constraint, which is why the lock is loud",
    async () => {
      // The counter-case that makes the test above honest: two sweeps over the same
      // morning DO both run, and the second one is stopped by the database rather than
      // by the lock. If this ever starts sending two leads, the lock is the only thing
      // between a user and two morning texts — and a lock is not a correctness mechanism.
      const scope = await user(LA, morning(0, LA));
      const channel = new StubChannel();

      const a = await sweepOnce(morning(0, LA), deps(channel));
      const b = await sweepOnce(new Date(morning(0, LA).getTime() + 60_000), deps(channel));

      const mine = (r: { outcomes: Array<{ user_id: string; status: string }> }) =>
        r.outcomes.find((o) => o.user_id === scope.user_id);
      expect(mine(a)?.status).toBe("sent");
      // The SECOND sweep ran the whole tick again and was stopped by the database, not by
      // the lock. If this ever reads `sent`, the advisory lock is the only thing between a
      // user and two morning texts — and a lock is an operational convenience, not a
      // correctness mechanism.
      expect(mine(b)?.status).toBe("already_sent");
      expect((await listBriefs(scope)).length).toBe(1);
      expect(channel.sent.filter(
        (m) => m.user_id === scope.user_id && m.idempotency_key.endsWith("-lead")).length).toBe(1);
    }, 300_000);
});

describe("the fleet heartbeat read", () => {
  /**
   * The fleet aggregate is GLOBAL by definition — it is the correlation across users, and
   * that is the only thing it is for. So the test has to own the fleet: a leftover device
   * from another suite is another Mac in the count, exactly as a real one would be.
   */
  async function clearFleet(): Promise<void> {
    await getPool().query("delete from users");
  }

  /** N devices, `quiet` of them last seen `staleHours` ago, the rest seen just now. */
  async function fleet(
    total: number, quiet: number, now: Date, appVersion = "1.4.0", neverSynced = 0,
  ) {
    for (let i = 0; i < total; i += 1) {
      const scope = await user(LA, now);
      const deviceId = newDeviceId();
      await registerDevice(scope, { device_id: deviceId, platform: "test" });
      const seenAt = i < quiet
        ? new Date(now.getTime() - 72 * 3_600_000)
        : new Date(now.getTime() - 60_000);
      // AMENDMENT-003: a device that is reporting and has never synced sends
      // `digest_as_of: null`, which is a claim rather than an omission.
      const synced = i >= quiet && i < quiet + neverSynced
        ? null
        : new Date(now.getTime() - 2 * 3_600_000);
      await recordHeartbeat(scope, deviceId, seenAt, {
        app_version: appVersion,
        digest_as_of: synced?.toISOString() ?? null,
      });
    }
  }

  it("trips when eight of ten go quiet on the same day, and not when two do", async () => {
    // The aggregate IS the signal. `CONTRACTS.md` § 10 hole 8: an auto-update that binds
    // TCC to a versioned bundle path drops Full Disk Access for every Mac in the fleet on
    // one day, and from any single user's row that is indistinguishable from somebody
    // closing their laptop. Both directions asserted, because an alarm that fires on two
    // quiet devices is one people learn to ignore.
    const now = new Date(Date.UTC(2026, 8, 14, 16, 0, 0));
    await clearFleet();

    await fleet(10, 2, now);
    const calm = await fleetHeartbeatHealth({ now });
    expect(calm.devices).toBe(10);
    expect(calm.quiet).toBe(2);
    expect(calm.alarm).toBe(false);

    // Reset, then the fleet event.
    created.length = 0;
    await clearFleet();

    await fleet(10, 8, now);
    const alarmed = await fleetHeartbeatHealth({ now });
    expect(alarmed.devices).toBe(10);
    expect(alarmed.quiet).toBe(8);
    expect(alarmed.alarm).toBe(true);
    // And it names the version, which is what makes it actionable: `bundle_path_stable`
    // never crosses the wire, `app_version` does.
    expect(alarmed.by_app_version[0]?.app_version).toBe("1.4.0");
    expect(alarmed.by_app_version[0]?.quiet).toBe(8);
  }, 300_000);

  it("puts granted-but-never-synced in its OWN bucket rather than counting it healthy",
    async () => {
      // AMENDMENT-003's reason for existing. These Macs have Full Disk Access, heartbeat
      // every hour, and have never produced a digest — a BROKEN SYNC, which is a
      // different failure from a quiet Mac with a different fix. Before `digest_as_of`
      // could be null the state was unrepresentable and they counted as healthy.
      const now = new Date(Date.UTC(2026, 8, 14, 16, 0, 0));
      await clearFleet();
      await fleet(10, 0, now, "1.4.0", 8);

      const health = await fleetHeartbeatHealth({ now });
      expect(health.devices).toBe(10);
      // Not quiet: every one of them is reporting.
      expect(health.quiet).toBe(0);
      expect(health.alarm).toBe(false);
      // And not healthy either.
      expect(health.never_synced).toBe(8);
      expect(health.sync_alarm).toBe(true);
      expect(health.by_app_version[0]?.never_synced).toBe(8);

      // The two alarms are different events with different remedies. A single
      // "fleet unhealthy" line would send somebody to look at TCC grants when the
      // grants are fine.
      const event = fleetHealthEvent(health);
      expect(event["msg"]).toBe("fleet.never_synced_alarm");
      expect(String(event["consequence"])).toContain("grant is fine and the sync is not");
    }, 300_000);

  it("counts a device that is BOTH quiet and never-synced as quiet, once", async () => {
    // Otherwise the two shares add up to more than the fleet, and "we have not heard
    // from it" is the more fundamental fact — a device we cannot reach tells us nothing
    // about whether its sync works.
    const now = new Date(Date.UTC(2026, 8, 14, 16, 0, 0));
    await clearFleet();
    await fleet(6, 6, now, "1.4.0", 6);

    const health = await fleetHeartbeatHealth({ now });
    expect(health.quiet).toBe(6);
    expect(health.never_synced).toBe(0);
    expect(health.quiet + health.never_synced).toBeLessThanOrEqual(health.devices);
  }, 300_000);

  it("does not alarm on a fleet too small to mean anything", async () => {
    // Three of three quiet is 100% and is three people. A share over a tiny denominator
    // is arithmetic, not evidence.
    const now = new Date(Date.UTC(2026, 8, 14, 16, 0, 0));
    await clearFleet();
    await fleet(3, 3, now);
    const health = await fleetHeartbeatHealth({ now });
    expect(health.quiet_share).toBe(1);
    expect(health.alarm).toBe(false);
  }, 300_000);

  it("counts a device that has NEVER reported as quiet", async () => {
    // A Mac that paired and never came back is the worst version of the same symptom:
    // the grant may never have worked at all. Treating null as "no evidence" would hide
    // exactly the users a launch-day TCC bug produces.
    const now = new Date(Date.UTC(2026, 8, 14, 16, 0, 0));
    await clearFleet();
    const scope = await user(LA, now);
    await registerDevice(scope, { device_id: newDeviceId(), platform: "test" });
    const health = await fleetHeartbeatHealth({ now, minimumDevices: 1 });
    expect(health.quiet).toBe(1);
    expect(health.alarm).toBe(true);
  }, 300_000);
});

describe("what the sweep reads", () => {
  it("enumerates users from the database rather than from a list somebody passed it",
    async () => {
      // `allUserSchedules()` existed and had no caller — the same shape as `TickDeps`
      // and as `runForUser` itself. A sweep driven by an injected array would pass every
      // test above and deliver to nobody in production.
      const scope = await user(LA, morning(0, LA));
      const schedules = await allUserSchedules();
      expect(schedules.some((s) => s.user_id === scope.user_id)).toBe(true);

      const channel = new StubChannel();
      const result = await sweepOnce(morning(0, LA), {
        channel,
        gistsFor: async () => gistsForDigest(),
        draftsFor: async () => new Map<string, DraftBundle>(),
        log: () => {},
      });
      expect(result.considered).toBe(schedules.length);
      expect(result.outcomes.some((o) => o.user_id === scope.user_id)).toBe(true);
    }, 300_000);
});

// A last, deliberately boring check: the pool is the one the rest of the suite uses, so a
// leaked connection here shows up as a hang there rather than as a mystery in CI.
it("holds no connection of its own after the suite", async () => {
  expect(getPool()).toBeDefined();
});

// ---------------------------------------------------------------------------
// The PROCESS, not the sweep.
//
// Everything above drives `sweepOnce` directly, which is the right way to assert
// behaviour and proves nothing about `npm run scheduler` existing, starting, or
// surviving a SIGTERM. This section spawns the real entry point as its own OS process and
// asserts on rows it left behind — the only evidence that survives the process dying.

describe("npm run scheduler", () => {
  it("delivers to a due user with no manual step, and drains on SIGTERM", async () => {
    const at = morning(0, LA);
    const scope = await user(LA, at);

    const child = spawn(
      process.execPath,
      [path.join(REPO_ROOT, "node_modules", "vite-node", "vite-node.mjs"),
        path.join(REPO_ROOT, "cloud", "scheduler", "src", "main.ts")],
      {
        env: {
          ...process.env,
          BOI_SCHEDULER_FAKE_NOW: at.toISOString(),
          BOI_SCHEDULER_INTERVAL_MS: "1000",
          BOI_CARD_BASE: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    try {
      // SIGTERM AS SOON AS THE SWEEP STARTS, deliberately — before the brief exists.
      //
      // The first version of this waited for the row and then signalled, which made the
      // drain assertion a formality: the tick was already finished, so a shutdown that
      // dropped in-flight work on the floor passed it. Signalling mid-tick is the only
      // arrangement where "drains" and "exits" are different behaviours.
      for (let i = 0; i < 240 && !stdout.includes("sweep.start"); i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(stdout, stdout.slice(-2000)).toContain("sweep.start");

      const exited = new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      });
      child.kill("SIGTERM");
      const code = await exited;
      expect(code, stdout.slice(-2000)).toBe(0);
      expect(stdout).toContain("scheduler.draining");
      expect(stdout).toContain("scheduler.stopped");

      // The brief the process was in the middle of is COMPLETE, asserted after the
      // process is gone. A row, a card, outbound rows and a send, in that order: killed
      // between the row and the send it would sit at `pending`, and the next attempt
      // resuming it is a second chance rather than a plan.
      const briefs = await listBriefs(scope);
      expect(briefs.length, stdout.slice(-3000)).toBe(1);
      expect(briefs[0]?.delivery_status).toBe("sent");

      const outbound = await listOutboundMessages(scope);
      expect(outbound.length).toBeGreaterThan(0);
      expect(outbound.every((r) => r.status === "sent")).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 300_000);

  it("says so and exits when another instance already holds the lock", async () => {
    // The collision has to reach a human. The database would absorb the duplicate in
    // silence, and two schedulers running for a month look exactly like one.
    const held = await acquireSchedulerLock();
    expect(held.held).toBe(true);
    try {
      const child = spawn(
        process.execPath,
        [path.join(REPO_ROOT, "node_modules", "vite-node", "vite-node.mjs"),
          path.join(REPO_ROOT, "cloud", "scheduler", "src", "main.ts")],
        { env: { ...process.env, BOI_SCHEDULER_INTERVAL_MS: "1000" }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      const code = await new Promise<number | null>((resolve) => {
        child.on("exit", (c) => resolve(c));
      });

      expect(code).toBe(0);
      expect(stdout).toContain("scheduler.collision");
      // As an error, not an info line. A collision logged at info is a collision nobody
      // alerts on.
      expect(stdout).toContain('"level":"error"');
      // And it did NOT sweep: no start line at all.
      expect(stdout).not.toContain("sweep.start");
    } finally {
      await held.release();
    }
  }, 300_000);
});
