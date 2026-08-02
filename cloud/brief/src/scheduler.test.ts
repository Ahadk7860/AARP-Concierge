// The scheduler and the inbound resolver, against a live `boi_dev_d`.
//
// Serialised against the other database-touching files by the advisory lock in
// cloud/db/src/test-lock.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StubChannel } from "../../shared/src/index.js";
import type {
  Capabilities,
  Channel,
  ChannelHealth,
  Digest,
  DraftBundle,
  Gist,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from "../../shared/src/index.js";
import {
  acquireSuiteLock,
  closePool,
  createUser,
  deleteUser,
  getPool,
  insertDigest,
  latestBrief,
  migrate,
  newDeviceId,
  newDigestId,
  registerDevice,
  releaseSuiteLock,
  residueByTable,
  type UserScope,
} from "../../db/src/index.js";
import { runForUser, runForUserWithRetry, type TickDeps } from "./run.js";
import {
  dueUsers,
  isDue,
  localDayKey,
  MAX_SEND_ATTEMPTS,
  nextRetry,
  slotFor,
  WINDOW_MINUTES,
} from "./scheduler.js";
import { handleInbound, parseSelection, resolveSelection, resolveUser } from "./inbound.js";
import { DEFAULT_SKIP_HOURS } from "./staleness.js";

const ROOT = process.cwd();
const FIXTURES = join(ROOT, "contracts", "fixtures");
const OUT = "/tmp/boi-d/scheduler";
mkdirSync(OUT, { recursive: true });
const pool = getPool();

function fixture<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURES, ...parts), "utf8")) as T;
}

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1559${String(1_000_000 + phoneCounter).slice(-7)}`;
}

/** A recording channel whose capabilities the test controls. */
function channelWith(capabilities: Partial<Capabilities> = {}): Channel & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    async send(msg: OutboundMessage): Promise<SendResult> {
      sent.push(msg);
      return {
        message_id: `lmsg_stub${sent.length}`,
        provider: "mock",
        protocol: "imessage",
        line_id: "line_stub_1",
      };
    },
    async capabilities(): Promise<Capabilities> {
      return {
        tapbacks: true, images: true, groups: false, typing: true,
        richlinks: true, contact_cards: true, threading: true,
        ...capabilities,
      };
    },
    async health(): Promise<ChannelHealth> {
      return { status: "up", line_id: "line_stub_1", checked_at: new Date().toISOString() };
    },
    normalizeInbound(): InboundMessage {
      throw new Error("not used");
    },
  };
}

const cleanup: UserScope[] = [];

/** An account with a stored digest, ready to be briefed. */
async function seededUser(timezone: string, digestAsOf: Date): Promise<UserScope> {
  const { scope } = await createUser({ phone_e164: nextPhone(), timezone });
  cleanup.push(scope);
  const deviceId = newDeviceId();
  await registerDevice(scope, { device_id: deviceId, platform: "test" });

  const digest = fixture<Digest>("digest", "healthy.json");
  digest.user_id = scope.user_id;
  digest.device_id = deviceId;
  digest.corpus.as_of = digestAsOf.toISOString();
  digest.generated_at = digestAsOf.toISOString();
  await insertDigest(scope, { digest_id: newDigestId(), digest });
  return scope;
}

function gistFixtures(): Gist[] {
  return [
    fixture<Gist>("gist", "maya_action_needed.json"),
    fixture<Gist>("gist", "yu_fading_sql_only.json"),
  ];
}

function deps(over: Partial<TickDeps> & { now: Date }): TickDeps {
  const bundle = fixture<DraftBundle>("draft_bundle", "maya_pass.json");
  return {
    channel: channelWith(),
    gistsFor: async () => gistFixtures(),
    draftsFor: async () => new Map([[bundle.gist_id, bundle]]),
    ...over,
  };
}

beforeAll(async () => {
  await acquireSuiteLock();
  await migrate(pool);
}, 120_000);

afterAll(async () => {
  for (const scope of cleanup) {
    try {
      await deleteUser(scope);
    } catch {
      // already gone
    }
  }
  await closePool();
  await releaseSuiteLock();
});

// ---------------------------------------------------------------------------

describe("8am local, in three timezones", () => {
  it("fires each user within 15 minutes of their own 8am — controlled clock, no sleeping", () => {
    const zones = ["America/Los_Angeles", "Europe/London", "Asia/Tokyo"];

    // One UTC instant is 8am in exactly one of these. Walking a whole UTC day proves
    // each fires once, in its own morning, rather than all three at 08:00Z.
    const fired = new Map<string, Date[]>(zones.map((z) => [z, []]));
    for (let minute = 0; minute < 24 * 60; minute += 5) {
      const now = new Date(Date.UTC(2026, 7, 3, 0, minute));
      for (const zone of zones) {
        if (isDue(now, zone)) fired.get(zone)!.push(now);
      }
    }

    for (const zone of zones) {
      const hits = fired.get(zone)!;
      expect(hits.length, `${zone} fired ${hits.length} times`).toBeGreaterThan(0);
      for (const at of hits) {
        const local = new Intl.DateTimeFormat("en-US", {
          timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
        }).format(at);
        const [h, m] = local.split(":").map(Number);
        expect(h, `${zone} fired at ${local}`).toBe(8);
        expect(m!).toBeLessThan(WINDOW_MINUTES);
      }
    }

    // And no two zones fire at the same instant, which is the whole point.
    const la = fired.get("America/Los_Angeles")!.map((d) => d.toISOString());
    const tokyo = fired.get("Asia/Tokyo")!.map((d) => d.toISOString());
    expect(la.some((t) => tokyo.includes(t))).toBe(false);

    writeFileSync(
      join(OUT, "three-timezones.json"),
      JSON.stringify(
        Object.fromEntries([...fired].map(([z, ds]) => [z, ds.map((d) => d.toISOString())])),
        null,
        2,
      ),
    );
  });

  it("gives every tick inside one window the same scheduled_for", () => {
    // The idempotency key. Two ticks four minutes apart must collide, not stack.
    const zone = "America/Los_Angeles";
    const first = new Date("2026-08-03T15:01:00Z");
    const second = new Date("2026-08-03T15:09:00Z");
    expect(isDue(first, zone)).toBe(true);
    expect(isDue(second, zone)).toBe(true);
    expect(slotFor(first, zone).toISOString()).toBe(slotFor(second, zone).toISOString());

    // And that instant really is 08:00 local.
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(slotFor(first, zone));
    expect(local).toBe("08:00");
  });

  it("tracks a DST shift rather than drifting an hour", () => {
    // 2026-03-08 is the US spring-forward. The UTC instant of 8am local moves; the
    // LOCAL time must not. Arithmetic on a fixed offset gets this wrong twice a year.
    const zone = "America/Los_Angeles";
    const before = slotFor(new Date("2026-03-07T16:05:00Z"), zone);
    const after = slotFor(new Date("2026-03-09T15:05:00Z"), zone);
    for (const at of [before, after]) {
      const local = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).format(at);
      expect(local).toBe("08:00");
    }
    // Same local hour, different UTC offset — that is the shift.
    expect(before.getUTCHours()).not.toBe(after.getUTCHours());
  });

  it("selects only the users whose morning it is", () => {
    const users = [
      { user_id: "usr_la0000000001", timezone: "America/Los_Angeles" },
      { user_id: "usr_ldn000000001", timezone: "Europe/London" },
      { user_id: "usr_tky000000001", timezone: "Asia/Tokyo" },
    ];
    const due = dueUsers(new Date("2026-08-03T07:05:00Z"), users);
    expect(due.map((u) => u.timezone)).toEqual(["Europe/London"]);
  });

  it("keys the day by the USER's calendar", () => {
    // 2026-08-03T23:30Z is already the 4th in Tokyo.
    const at = new Date("2026-08-03T23:30:00Z");
    expect(localDayKey(at, "Asia/Tokyo")).toBe("2026-08-04");
    expect(localDayKey(at, "America/Los_Angeles")).toBe("2026-08-03");
  });
});

// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("running twice produces one brief and one set of sends", async () => {
    const now = new Date("2026-08-03T15:02:00Z"); // 08:02 in Los Angeles
    const scope = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3 * 3_600_000));
    const schedule = { user_id: scope.user_id, timezone: "America/Los_Angeles" };
    const channel = channelWith();

    const first = await runForUser(schedule, deps({ now, channel }));
    expect(first.status).toBe("sent");

    // A second tick, later in the same window.
    const second = await runForUser(
      schedule,
      deps({ now: new Date("2026-08-03T15:11:00Z"), channel }),
    );
    expect(second.status).toBe("already_sent");
    if (second.status !== "already_sent" || first.status !== "sent") return;
    expect(second.brief_id).toBe(first.brief_id);

    // One brief row, and no messages beyond the first tick's.
    const residue = await residueByTable(scope.user_id, pool);
    expect(residue["briefs"]).toBe(1);
    expect(channel.sent).toHaveLength(first.messages);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("staleness skips the send, and records why", () => {
  it("sends nothing past the hard threshold", async () => {
    const now = new Date("2026-08-03T15:02:00Z");
    const scope = await seededUser(
      "America/Los_Angeles",
      new Date(now.getTime() - (DEFAULT_SKIP_HOURS + 2) * 3_600_000),
    );
    const channel = channelWith();
    const logs: Array<Record<string, unknown>> = [];

    const outcome = await runForUser(
      { user_id: scope.user_id, timezone: "America/Los_Angeles" },
      deps({ now, channel, log: (e) => logs.push(e) }),
    );

    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") return;
    expect(outcome.reason).toBe("digest_too_stale");
    expect(channel.sent).toHaveLength(0);

    // Recorded, not merely logged: the brief row survives the log retention window.
    const row = await latestBrief(scope);
    expect(row).not.toBeNull();
    expect(row?.warn).toBe(true);
    expect(Number(row?.hours_stale)).toBeGreaterThan(DEFAULT_SKIP_HOURS);
    expect(logs.map((l) => l["msg"])).toContain("brief.skipped");

    writeFileSync(join(OUT, "skip-record.json"), JSON.stringify({ outcome, logs }, null, 2));
  }, 60_000);

  it("skips a user whose Mac has never reported at all", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone(), timezone: "Europe/London" });
    cleanup.push(scope);
    const channel = channelWith();
    const outcome = await runForUser(
      { user_id: scope.user_id, timezone: "Europe/London" },
      deps({ now: new Date("2026-08-03T07:02:00Z"), channel }),
    );
    // Not "too stale" — there is nothing to be stale. A different answer for a
    // different situation.
    expect(outcome.status === "skipped" && outcome.reason).toBe("no_digest");
    expect(channel.sent).toHaveLength(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("retry is bounded and is not a loop", () => {
  it("stops after MAX_SEND_ATTEMPTS, with a time rather than a sleep", () => {
    const now = new Date("2026-08-03T15:00:00Z");
    const seen: Array<string | null> = [];
    let attempt = 0;
    for (let i = 0; i < 10; i += 1) {
      const retry = nextRetry(attempt, now);
      seen.push(retry.next_attempt_at);
      if (retry.exhausted) break;
      attempt = retry.attempt;
    }
    // Bounded: three schedulable attempts then a null.
    expect(seen.filter((t) => t !== null)).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(seen.at(-1)).toBeNull();
    expect(attempt).toBe(MAX_SEND_ATTEMPTS);

    // And each is strictly later than the last — a backoff, not a tight loop.
    const times = seen.filter((t): t is string => t !== null).map((t) => Date.parse(t));
    for (let i = 1; i < times.length; i += 1) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    expect(times[0]!).toBeGreaterThan(now.getTime());
  });

  it("returns a failed outcome with a next attempt, and calls the channel once", async () => {
    const now = new Date("2026-08-03T15:02:00Z");
    const scope = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3_600_000));

    let calls = 0;
    const exploding = channelWith();
    exploding.send = async () => {
      calls += 1;
      throw new Error("line_banned");
    };

    const outcome = await runForUserWithRetry(
      { user_id: scope.user_id, timezone: "America/Los_Angeles" },
      deps({ now, channel: exploding }),
    );

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.attempt).toBe(1);
    expect(outcome.next_attempt_at).not.toBeNull();
    // ONE call. A retry storm against a banned line is how a ban becomes permanent.
    expect(calls).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("the reply that matters: '2'", () => {
  it("parses only a bare 1 or 2", () => {
    expect(parseSelection("2")).toBe(1);
    expect(parseSelection(" 1 ")).toBe(0);
    expect(parseSelection("2.")).toBe(1);
    for (const no of ["3", "0", "two", "2 please", "", null, "12"]) {
      expect(parseSelection(no), String(no)).toBeNull();
    }
  });

  it("selects the second candidate of the correct item, matched via reply_to_message_id", async () => {
    const now = new Date("2026-08-03T15:02:00Z");
    const scope = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3_600_000));
    const channel = channelWith({ threading: true });

    const outcome = await runForUser(
      { user_id: scope.user_id, timezone: "America/Los_Angeles" },
      deps({ now, channel }),
    );
    expect(outcome.status).toBe("sent");

    // Which provider id did the FIRST ITEM's message come back as? That is the mapping.
    const brief = await latestBrief(scope);
    const mayaIndex = brief!.payload.items.findIndex((i) => i.drafts !== null);
    expect(mayaIndex).toBeGreaterThanOrEqual(0);
    const providerId = `lmsg_stub${mayaIndex + 2}`; // lead is stub1, items follow

    const inbound = fixture<InboundMessage>("inbound", "draft_choice_2.json");
    inbound.user_id = scope.user_id;
    inbound.from_handle = "+15550000000";
    inbound.reply_to_message_id = providerId;

    const selection = await resolveSelection(inbound, scope);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;

    expect(selection.item_index).toBe(mayaIndex);
    // "2" is the SECOND candidate — the defer, not the answer.
    expect(selection.candidate_index).toBe(1);
    const expected = brief!.payload.items[mayaIndex]!.drafts!.candidates[1]!;
    expect(selection.candidate.text).toBe(expected.text);
    expect(selection.candidate.stance).toBe("defer");

    writeFileSync(
      join(OUT, "reply-2-exchange.json"),
      JSON.stringify({ inbound, selection }, null, 2),
    );
  }, 60_000);

  it("hands the text back to the USER and sends nothing to the third party", async () => {
    const now = new Date("2026-08-03T15:02:00Z");
    const scope = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3_600_000));
    const briefChannel = channelWith({ threading: true });
    await runForUser(
      { user_id: scope.user_id, timezone: "America/Los_Angeles" },
      deps({ now, channel: briefChannel }),
    );

    const brief = await latestBrief(scope);
    const mayaIndex = brief!.payload.items.findIndex((i) => i.drafts !== null);

    // A fresh channel, so `sent` contains only the reply.
    const replyChannel = channelWith({ threading: true });
    const inbound = fixture<InboundMessage>("inbound", "draft_choice_2.json");
    inbound.user_id = scope.user_id;
    inbound.reply_to_message_id = `lmsg_stub${mayaIndex + 2}`;

    const result = await handleInbound({ inbound, channel: replyChannel });

    // EXACTLY ONE message, addressed to the user.
    expect(replyChannel.sent).toHaveLength(1);
    const reply = replyChannel.sent[0]!;
    expect(reply.user_id).toBe(scope.user_id);

    // It contains the draft text, for the user to copy.
    const text = reply.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const chosen = brief!.payload.items[mayaIndex]!.drafts!.candidates[1]!.text;
    expect(text).toContain(chosen);

    // And nothing anywhere addresses the contact. outbound.v1 has no recipient field,
    // and the contact's own id never appears.
    expect(JSON.stringify(reply)).not.toContain(brief!.payload.items[mayaIndex]!.contact_id);
    expect(result.selection.kind).toBe("selected");

    writeFileSync(
      join(OUT, "reply-2-sent.json"),
      JSON.stringify({ inbound, sent: replyChannel.sent }, null, 2),
    );
  }, 60_000);

  it("attributes a bare 2 to the most recent brief when threading is unavailable", async () => {
    const now = new Date("2026-08-03T15:02:00Z");
    const scope = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3_600_000));
    const channel = channelWith({ threading: false });

    // One item only, so an unthreaded "2" is unambiguous.
    const bundle = fixture<DraftBundle>("draft_bundle", "maya_pass.json");
    const onlyMaya = gistFixtures().filter((g) => g.gist_id === bundle.gist_id);
    await runForUser(
      { user_id: scope.user_id, timezone: "America/Los_Angeles" },
      deps({ now, channel, gistsFor: async () => onlyMaya }),
    );
    expect(channel.sent).toHaveLength(1); // unthreaded: one message

    const inbound = fixture<InboundMessage>("inbound", "draft_choice_2.json");
    inbound.user_id = scope.user_id;
    inbound.reply_to_message_id = null; // no threading, so no id to match

    const selection = await resolveSelection(inbound, scope);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    const brief = await latestBrief(scope);
    expect(selection.brief_id).toBe(brief!.brief_id);
    expect(selection.item_index).toBe(0);
    expect(selection.candidate_index).toBe(1);
  }, 60_000);

  it("asks rather than guesses when an unthreaded reply could mean three people", async () => {
    const now = new Date("2026-08-03T15:02:00Z");
    const scope = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3_600_000));
    const channel = channelWith({ threading: false });
    await runForUser(
      { user_id: scope.user_id, timezone: "America/Los_Angeles" },
      deps({ now, channel }),
    );

    const inbound = fixture<InboundMessage>("inbound", "draft_choice_2.json");
    inbound.user_id = scope.user_id;
    inbound.reply_to_message_id = null;

    const selection = await resolveSelection(inbound, scope);
    // Two items and no thread. Picking the first would be a guess.
    expect(selection.kind).toBe("ambiguous");
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("replies that match nothing", () => {
  it("responds gracefully to a reply with no brief at all, and does not throw", async () => {
    const { scope } = await createUser({ phone_e164: nextPhone(), timezone: "Europe/London" });
    cleanup.push(scope);
    const channel = channelWith();

    const inbound = fixture<InboundMessage>("inbound", "draft_choice_2.json");
    inbound.user_id = scope.user_id;

    const result = await handleInbound({ inbound, channel });
    expect(result.selection.kind).toBe("no_brief");
    expect(channel.sent).toHaveLength(1);
    const text = channel.sent[0]!.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    expect(text.length).toBeGreaterThan(0);
    // No draft invented for a brief that does not exist.
    expect(text).not.toMatch(/answer:|defer:/);
  }, 60_000);

  it("says nothing at all to a handle with no account", async () => {
    const channel = channelWith();
    const inbound = fixture<InboundMessage>("inbound", "draft_choice_2.json");
    inbound.user_id = null;
    inbound.from_handle = "+15550009999";

    const result = await handleInbound({ inbound, channel });
    expect(result.selection.kind).toBe("unknown_user");
    // Replying would confirm to a stranger that this number is a service.
    expect(channel.sent).toHaveLength(0);
  }, 60_000);

  it("resolves the user from their own handle when the transport did not", async () => {
    const phone = nextPhone();
    const { scope } = await createUser({ phone_e164: phone, timezone: "Europe/London" });
    cleanup.push(scope);

    const inbound = fixture<InboundMessage>("inbound", "draft_choice_2.json");
    inbound.user_id = null;
    inbound.from_handle = phone;
    const resolved = await resolveUser(inbound);
    expect(resolved?.user_id).toBe(scope.user_id);
  }, 60_000);

  it("tells the user how to pick when the text is not a selection", async () => {
    const now = new Date("2026-08-03T15:02:00Z");
    const scope = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3_600_000));
    await runForUser(
      { user_id: scope.user_id, timezone: "America/Los_Angeles" },
      deps({ now, channel: channelWith() }),
    );

    const channel = channelWith();
    const inbound = fixture<InboundMessage>("inbound", "draft_choice_2.json");
    inbound.user_id = scope.user_id;
    inbound.text = "thanks!";
    inbound.reply_to_message_id = null;

    const result = await handleInbound({ inbound, channel });
    expect(result.selection.kind).toBe("not_a_selection");
    expect(channel.sent).toHaveLength(1);
  }, 60_000);

  it("does not invent a draft for a degraded item", async () => {
    const now = new Date("2026-08-03T15:02:00Z");
    const scope = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3_600_000));
    const channel = channelWith({ threading: false });

    // One item, and its bundle is the degraded one — zero candidates.
    const degraded = fixture<DraftBundle>("draft_bundle", "degraded_empty.json");
    const onlyYu = gistFixtures().filter((g) => g.gist_id === degraded.gist_id);
    await runForUser(
      { user_id: scope.user_id, timezone: "America/Los_Angeles" },
      deps({
        now,
        channel,
        gistsFor: async () => onlyYu,
        draftsFor: async () => new Map([[degraded.gist_id, degraded]]),
      }),
    );

    const replyChannel = channelWith();
    const inbound = fixture<InboundMessage>("inbound", "draft_choice_2.json");
    inbound.user_id = scope.user_id;
    inbound.reply_to_message_id = null;

    const result = await handleInbound({ inbound, channel: replyChannel });
    expect(result.selection.kind).toBe("no_drafts");
    const text = replyChannel.sent[0]!.blocks
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ");
    expect(text).toContain("no drafts");
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("the omsg -> provider id mapping", () => {
  it("matches whatever id the transport returns, without parsing its prefix", async () => {
    // The stub used to return `omsg_stub_N` and Track C's adapter returns `lmsg_...`.
    // Nothing in the resolver inspects the prefix, so both work — asserted here with a
    // deliberately alien id shape.
    const now = new Date("2026-08-03T15:02:00Z");
    const scope = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3_600_000));

    const alien = channelWith({ threading: true });
    let n = 0;
    alien.send = async (msg: OutboundMessage): Promise<SendResult> => {
      n += 1;
      alien.sent.push(msg);
      return {
        message_id: `xyz~weird~${n}`,
        provider: "mock",
        protocol: "imessage",
        line_id: "line_stub_1",
      };
    };

    await runForUser(
      { user_id: scope.user_id, timezone: "America/Los_Angeles" },
      deps({ now, channel: alien }),
    );

    const brief = await latestBrief(scope);
    const mayaIndex = brief!.payload.items.findIndex((i) => i.drafts !== null);

    const inbound = fixture<InboundMessage>("inbound", "draft_choice_2.json");
    inbound.user_id = scope.user_id;
    inbound.reply_to_message_id = `xyz~weird~${mayaIndex + 2}`;

    const selection = await resolveSelection(inbound, scope);
    expect(selection.kind).toBe("selected");
    if (selection.kind !== "selected") return;
    expect(selection.item_index).toBe(mayaIndex);
  }, 60_000);

  it("does not attribute one user's reply to another user's message", async () => {
    const now = new Date("2026-08-03T15:02:00Z");
    const a = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3_600_000));
    const b = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3_600_000));

    await runForUser({ user_id: a.user_id, timezone: "America/Los_Angeles" }, deps({ now, channel: channelWith() }));
    await runForUser({ user_id: b.user_id, timezone: "America/Los_Angeles" }, deps({ now, channel: channelWith() }));

    // Both channels minted `lmsg_stub2`. B replying to that id must resolve within B.
    const inbound = fixture<InboundMessage>("inbound", "draft_choice_2.json");
    inbound.user_id = b.user_id;
    inbound.reply_to_message_id = "lmsg_stub2";

    const selection = await resolveSelection(inbound, b);
    const bBrief = await latestBrief(b);
    expect(selection.kind === "selected" && selection.brief_id).toBe(bBrief!.brief_id);

    const aBrief = await latestBrief(a);
    expect(bBrief!.brief_id).not.toBe(aBrief!.brief_id);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("StubChannel still works end to end", () => {
  it("runs a tick against the foundation stub", async () => {
    const now = new Date("2026-08-03T15:02:00Z");
    const scope = await seededUser("America/Los_Angeles", new Date(now.getTime() - 3_600_000));
    const stub = new StubChannel();
    const outcome = await runForUser(
      { user_id: scope.user_id, timezone: "America/Los_Angeles" },
      deps({ now, channel: stub }),
    );
    expect(outcome.status).toBe("sent");
    expect(stub.sent.length).toBeGreaterThan(0);
  }, 60_000);
});
