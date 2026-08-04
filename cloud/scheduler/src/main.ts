// `npm run scheduler`. The process that makes the daily brief a product.
//
// One process, one interval, no queue and no workers — prompt 07 puts all three out of
// scope, and a sweep over `dueUsers()` at this scale is a single indexed read.
//
// A file whose only job is to run, for the reason prompt 04 paid for: an
// `if (process.argv[1] === …)` guard inside a module reports success having executed
// nothing when the runner is `vite-node`.

import { closePool } from "../../db/src/index.js";
import { StubChannel } from "../../shared/src/index.js";
import { tickDeps } from "../../brief/src/run.js";
import { bridgeDeps } from "../../intelligence-bridge/src/index.js";
import { acquireSchedulerLock } from "./lock.js";
import { cardForFromEnvironment } from "./card.js";
import { fleetHealthEvent, fleetHeartbeatHealth } from "./fleet.js";
import { sweepOnce } from "./sweep.js";

/**
 * How often to wake.
 *
 * Five minutes against a fifteen-minute send window (`WINDOW_MINUTES`), so a user's
 * morning is checked three times before it closes and a single missed tick is not a
 * missed brief. The window is what makes this safe: `slotFor` collapses every tick inside
 * one window onto the same `scheduled_for`, and `unique (user_id, scheduled_for)` makes
 * the second and third ticks no-ops.
 */
const INTERVAL_MS = Number(process.env["BOI_SCHEDULER_INTERVAL_MS"] ?? 5 * 60_000);

/** The fleet read is an aggregate; hourly is plenty and it never gates a send. */
const FLEET_INTERVAL_MS = Number(process.env["BOI_FLEET_INTERVAL_MS"] ?? 60 * 60_000);

/**
 * A fixed clock, for driving this process from a test.
 *
 * Every scheduling function downstairs takes `now` as a parameter — the sweep, `isDue`,
 * `slotFor` — and this is the one place that calls `new Date()`. Without a seam here the
 * only way to test the PROCESS (rather than the sweep) is to wait for 08:00 in some real
 * timezone, and the send window is fifteen minutes wide with no IANA offset landing in
 * the 15–29 minute range, so for half of every hour there is no timezone that makes a
 * user due.
 *
 * It is deliberately loud rather than hidden: a WARN on every startup that has it set,
 * naming the consequence. A silent fake clock in production is a product that stops
 * sending and looks healthy.
 */
function nowFn(): Date {
  const fake = process.env["BOI_SCHEDULER_FAKE_NOW"];
  return fake === undefined || fake === "" ? new Date() : new Date(fake);
}

const log = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
};

// The channel. `StubChannel` until Spectrum lands in `08` — and it is named in the
// startup line, because a scheduler that has been delivering to a stub for a week must
// not be discoverable only by reading the source.
const channel = new StubChannel();

const lock = await acquireSchedulerLock();
if (!lock.held) {
  // THE LOSER SAYS SO. The database would have absorbed the duplicate silently — a
  // second instance composing the same morning loses on `unique (user_id, scheduled_for)`
  // and reports `already_sent`, which reads exactly like a healthy no-op. Two schedulers
  // running for a month would look like one, until the day they disagree.
  log({
    msg: "scheduler.collision",
    level: "error",
    detail: "another instance holds the scheduler advisory lock; not sweeping",
    consequence: "this process will exit rather than sweep alongside it",
  });
  await closePool();
  process.exit(0);
}

if (process.env["BOI_SCHEDULER_FAKE_NOW"]) {
  log({
    msg: "scheduler.fake_clock",
    level: "warn",
    now: nowFn().toISOString(),
    consequence:
      "every send decision is made against this instant, not the real one. NEVER set "
      + "BOI_SCHEDULER_FAKE_NOW in production: the process stays green and stops sending.",
  });
}

log({
  msg: "scheduler.started",
  interval_ms: INTERVAL_MS,
  fleet_interval_ms: FLEET_INTERVAL_MS,
  channel: channel.constructor.name,
  provider: process.env["BOI_MODEL_PROVIDER"] ?? "fake",
  // Named at startup, because a scheduler that has been sending card-less briefs for a
  // week must not be discoverable only by reading the source.
  card_renderer: process.env["BOI_CARD_BASE"] ?? "none",
});

let draining = false;
let inFlight: Promise<unknown> = Promise.resolve();
let timer: NodeJS.Timeout | null = null;
let lastFleetAt = 0;

async function tick(): Promise<void> {
  if (draining) return;
  const now = nowFn();
  const deps = tickDeps(bridgeDeps({ log }), {
    now, channel, log, cardFor: cardForFromEnvironment(log),
  });
  inFlight = (async () => {
    try {
      await sweepOnce(now, deps);
      if (Date.now() - lastFleetAt >= FLEET_INTERVAL_MS) {
        lastFleetAt = Date.now();
        log(fleetHealthEvent(await fleetHeartbeatHealth({ now })));
      }
    } catch (err) {
      // A sweep that throws must not kill the process: tomorrow's brief is worth more
      // than today's stack trace, and `launchd`-style restarts are not in scope here.
      log({
        msg: "sweep.error",
        level: "error",
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  })();
  await inFlight;
}

async function shutdown(signal: string): Promise<void> {
  // SIGTERM DRAINS. A brief is a database row, a card, an outbound row and a send, in
  // that order; killed between the row and the send it leaves a `pending` brief that the
  // next attempt resumes — but the resume is a second chance, not a plan. Finishing the
  // tick in flight costs seconds.
  draining = true;
  if (timer !== null) clearInterval(timer);
  log({ msg: "scheduler.draining", signal });

  // KEEP THE EVENT LOOP ALIVE WHILE DRAINING, and this is not defensive coding — the
  // first version exited here with code 0, having logged `scheduler.draining` and
  // nothing else, with the tick still mid-flight. Clearing the interval removed the
  // last referenced handle, and the intelligence bridge `unref`s its subprocess, so Node
  // saw an empty loop and exited while a brief was half-written. A pending promise does
  // not keep a process alive.
  //
  // Found only because the test signals mid-tick. Signalling after the brief had landed
  // — the obvious way to write it — passed against a shutdown that dropped in-flight
  // work on the floor.
  const keepAlive = setInterval(() => {}, 250);

  // Bounded. A drain that waits forever on a wedged tick is a deploy that hangs, and the
  // brief it is protecting is already recoverable: the row sits `pending` and the next
  // attempt resumes it.
  const grace = Number(process.env["BOI_SCHEDULER_DRAIN_MS"] ?? 30_000);
  const timedOut = Symbol("drain_timeout");
  const raced = await Promise.race([
    inFlight.then(() => "drained" as const).catch(() => "drained" as const),
    new Promise((resolve) => setTimeout(() => resolve(timedOut), grace)),
  ]);
  if (raced === timedOut) {
    log({
      msg: "scheduler.drain_timeout",
      level: "error",
      grace_ms: grace,
      consequence: "a tick was still running. Its brief row stays `pending` and the next "
        + "instance resumes it; nothing is sent twice.",
    });
  }

  clearInterval(keepAlive);
  await lock.release();
  await closePool();
  log({ msg: "scheduler.stopped", signal, drained: raced !== timedOut });
  process.exit(0);
}

// THE SCHEDULER OWNS ITS OWN SHUTDOWN, so any handler the runner installed goes first.
//
// `vite-node` registers its own SIGTERM handler and calls `process.exit()` from it. With
// both installed the process logged `scheduler.draining`, ran two lines of ours, and was
// then killed mid-tick by the other handler — a drain that announced itself and did not
// happen, which is worse than no drain at all because the log says otherwise.
//
// Nothing else in this process has cleanup that matters: the pool and the advisory lock
// are released below, in order.
process.removeAllListeners("SIGTERM");
process.removeAllListeners("SIGINT");
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await tick();
timer = setInterval(() => void tick(), INTERVAL_MS);
