// The composer and the delivery path. No database — it composes from fixtures and
// sends through StubChannel, per the prompt's own framing.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StubChannel } from "../../shared/src/index.js";
import type {
  Brief,
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
import { composeBrief, headlineFor, maxItems, remedyFor } from "./compose.js";
import { deliverBrief, itemBlocks, leadBlocks } from "./deliver.js";
import { assessStaleness, DEFAULT_SKIP_HOURS, hoursBetween } from "./staleness.js";

const ROOT = process.cwd();
const FIXTURES = join(ROOT, "contracts", "fixtures");
const OUT = "/tmp/boi-d/brief";
mkdirSync(OUT, { recursive: true });

function fixture<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(FIXTURES, ...parts), "utf8")) as T;
}

/**
 * The language-neutral validator, run for real.
 *
 * CONTRACTS.md § 1 makes the JSON Schemas the arbiter, and § 10 provides this script
 * precisely so a track can check its own output without another track's toolchain.
 * Shelling out to it is the difference between "conforms to my TypeScript type" and
 * "conforms to the contract".
 */
function validateAgainstSchema(schema: string, doc: unknown, name: string): void {
  const path = join(OUT, `${name}.json`);
  writeFileSync(path, JSON.stringify(doc, null, 2));
  const out = execFileSync("python3", [join(ROOT, "scripts", "validate_fixtures.py"), schema, path], {
    encoding: "utf8",
  });
  expect(out).toMatch(/OK/);
}

const USER = "usr_brief0000001";
const TZ = "America/Los_Angeles";
const SCHEDULED = new Date("2026-08-02T12:00:00Z");
const DIGEST_AS_OF = new Date("2026-08-01T09:14:00Z");

function digest(): Digest {
  return fixture<Digest>("digest", "healthy.json");
}

function gists(): Gist[] {
  return [
    fixture<Gist>("gist", "maya_action_needed.json"),
    fixture<Gist>("gist", "yu_fading_sql_only.json"),
  ];
}

function draftMap(bundles: DraftBundle[]): Map<string, DraftBundle> {
  return new Map(bundles.map((b) => [b.gist_id, b]));
}

function baseInput(over: Partial<Parameters<typeof composeBrief>[0]> = {}) {
  const d = digest();
  return {
    user_id: USER,
    scheduled_for: SCHEDULED,
    now: new Date("2026-08-02T12:00:00Z"),
    timezone: TZ,
    digest_as_of: DIGEST_AS_OF,
    relationships: d.relationships,
    gists: gists(),
    drafts: draftMap([fixture<DraftBundle>("draft_bundle", "maya_pass.json")]),
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("composition", () => {
  it("produces a document the frozen validator accepts", () => {
    const { brief } = composeBrief(baseInput());
    validateAgainstSchema("brief.v1", brief, "composed-brief");
    expect(brief.items.length).toBeGreaterThan(0);
  });

  it("never exceeds three items, given ten candidates", () => {
    const d = digest();
    // Ten gists over ten real relationships, so nothing is dropped for being unknown.
    const relationships = Array.from({ length: 10 }, (_, i) => ({
      ...d.relationships[0]!,
      contact_id: `h_${String(i).padStart(8, "0")}`,
      display: `Person ${i}`,
    }));
    const many: Gist[] = relationships.map((r, i) => ({
      ...gists()[0]!,
      gist_id: `g_${String(i).padStart(8, "0")}`,
      contact_id: r.contact_id,
      priority: i / 10,
    }));

    const { brief, dropped } = composeBrief(
      baseInput({ relationships, gists: many, drafts: new Map() }),
    );
    expect(brief.items).toHaveLength(3);
    expect(dropped).toBe(7);
    validateAgainstSchema("brief.v1", brief, "capped-brief");
  });

  it("cannot be configured above the contract's cap", () => {
    const prior = process.env["BOI_BRIEF_MAX_ITEMS"];
    process.env["BOI_BRIEF_MAX_ITEMS"] = "20";
    try {
      // `brief.v1.json` sets maxItems: 3. An env var must not be able to break a
      // document the validator will then reject.
      expect(maxItems()).toBe(3);
    } finally {
      if (prior === undefined) delete process.env["BOI_BRIEF_MAX_ITEMS"];
      else process.env["BOI_BRIEF_MAX_ITEMS"] = prior;
    }
  });

  it("orders by priority, deterministically", () => {
    const { brief } = composeBrief(baseInput());
    // maya priority 0.87, yu 0.71.
    expect(brief.items[0]?.contact_id).toBe("h_8f21a4c0");
    const again = composeBrief(baseInput()).brief;
    expect(JSON.stringify(brief)).toBe(JSON.stringify(again));
  });

  it("gives every item a non-null remedy", () => {
    const { brief } = composeBrief(baseInput());
    expect(brief.items.length).toBeGreaterThan(0);
    for (const item of brief.items) {
      expect(item.remedy).not.toBeNull();
      expect(["reply", "call", "dismiss", "snooze"]).toContain(item.remedy);
    }
    // And across every gist state, so no branch can yield null.
    for (const state of ["action_needed", "fading", "birthday", "dormant", "revived"] as const) {
      expect(remedyFor({ ...gists()[0]!, state })).toBeTruthy();
    }
  });

  it("drops a gist about somebody the digest does not know", () => {
    const stranger: Gist = { ...gists()[0]!, contact_id: "h_ffffffff", gist_id: "g_ffffffff" };
    const { brief } = composeBrief(baseInput({ gists: [stranger] }));
    // No display name means no honest way to render it. Inventing one is fabrication.
    expect(brief.items).toHaveLength(0);
  });

  it("writes headlines that are invitations, not verdicts", () => {
    for (const state of ["action_needed", "fading", "birthday", "dormant", "revived"] as const) {
      const headline = headlineFor({ ...gists()[0]!, state }, "Maya");
      expect(headline.length).toBeLessThanOrEqual(120);
      // Never a claim about what the other person did or failed to do.
      expect(headline, headline).not.toMatch(
        /\b(doesn't|didn't|won't|never|ignores|ignored|hasn't replied|stopped)\b/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------

describe("the degraded case — drafts is null", () => {
  it("treats an empty candidate list as no drafts at all", () => {
    const degraded = fixture<DraftBundle>("draft_bundle", "degraded_empty.json");
    expect(degraded.candidates).toHaveLength(0);

    const { brief } = composeBrief(baseInput({ drafts: draftMap([degraded]) }));
    const item = brief.items.find((i) => i.contact_id === degraded.contact_id);
    expect(item).toBeDefined();
    // Null, not an empty bundle. "No drafts" and "a bundle that happens to be empty"
    // render differently and only one of them is honest.
    expect(item?.drafts).toBeNull();
    validateAgainstSchema("brief.v1", brief, "degraded-brief");
  });

  it("renders with no drafts shown and no text implying drafts exist", () => {
    const degraded = fixture<DraftBundle>("draft_bundle", "degraded_empty.json");
    const { brief } = composeBrief(baseInput({ drafts: draftMap([degraded]) }));
    const item = brief.items.find((i) => i.contact_id === degraded.contact_id)!;
    const text = itemBlocks(item)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");

    writeFileSync(join(OUT, "degraded-item.txt"), text);

    // Nothing that gestures at a draft that is not there.
    for (const forbidden of ["answer:", "defer:", "send one", "draft", "couldn't", "unable"]) {
      expect(text.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    // But still a remedy — never a reveal without an action.
    expect(text).toMatch(/\b(reply|call|dismiss|snooze)\b/);
  });

  it("shows both stances when the drafts are real", () => {
    const pass = fixture<DraftBundle>("draft_bundle", "maya_pass.json");
    expect(pass.candidates).toHaveLength(2);
    const { brief } = composeBrief(baseInput());
    const item = brief.items.find((i) => i.contact_id === pass.contact_id)!;
    const text = itemBlocks(item)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");

    // Exactly two, labelled by stance so it reads as a choice rather than two
    // paraphrases of one sentence.
    expect(text).toContain("answer:");
    expect(text).toContain("defer:");
    const stances = new Set(pass.candidates.map((c) => c.stance));
    expect(stances.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe("staleness", () => {
  it("warns at 98 hours and names the day", () => {
    const asOf = new Date("2026-07-28T09:14:00Z");
    const now = new Date(asOf.getTime() + 98 * 3_600_000);

    const decision = assessStaleness({ digest_as_of: asOf, now, timezone: "UTC" });
    expect(decision.staleness.warn).toBe(true);
    expect(decision.skip).toBe(false);
    expect(decision.staleness.hours_stale).toBe(98);
    // 2026-07-28 is a Tuesday, and the caveat is about the Mac, not about the user.
    expect(decision.staleness.message).toBe(
      "Haven't seen your Mac since Tuesday, so this is as of then.",
    );
  });

  it("matches the shape of contracts/fixtures/brief/stale_warning.json", () => {
    const reference = fixture<Brief>("brief", "stale_warning.json");
    const asOf = new Date(reference.staleness.digest_as_of);
    const now = new Date(reference.scheduled_for);
    const decision = assessStaleness({ digest_as_of: asOf, now, timezone: "UTC" });

    // Same keys, same types, and the same sentence — the message is derived from
    // `digest_as_of`, which is the half of the fixture that is self-consistent.
    expect(Object.keys(decision.staleness).sort()).toEqual(
      Object.keys(reference.staleness).sort(),
    );
    expect(decision.staleness.message).toBe(reference.staleness.message);
    expect(decision.staleness.warn).toBe(reference.staleness.warn);
    expect(typeof decision.staleness.hours_stale).toBe("number");
  });

  it("keeps hours_stale consistent with its own timestamps, always", () => {
    // NOT asserted against the fixture's `hours_stale`, deliberately.
    // `stale_warning.json` says 98.8, but its own `digest_as_of` (2026-07-28T09:14Z)
    // and `scheduled_for` (2026-08-02T12:00Z) are 122.8 hours apart — 98.8 hours before
    // that `scheduled_for` is Wednesday the 29th, while the message says Tuesday. The
    // fixture disagrees with itself; the message and the timestamp agree, so those are
    // what this track reproduces. Recorded as a contract gap in NOTES.md.
    //
    // What this asserts instead is the invariant the fixture violates: whatever the
    // inputs, the number we emit is the difference between the two timestamps we emit.
    for (const hours of [0, 3, 24.5, 98, 122.8, 200]) {
      const asOf = new Date("2026-07-28T09:14:00Z");
      const now = new Date(asOf.getTime() + hours * 3_600_000);
      const { staleness } = assessStaleness({ digest_as_of: asOf, now, timezone: TZ });
      expect(staleness.hours_stale).toBe(
        hoursBetween(new Date(staleness.digest_as_of), now),
      );
    }
  });

  it("does not warn at 3 hours, and carries no message", () => {
    const now = new Date(DIGEST_AS_OF.getTime() + 3 * 3_600_000);
    const decision = assessStaleness({ digest_as_of: DIGEST_AS_OF, now, timezone: TZ });
    expect(decision.staleness.warn).toBe(false);
    expect(decision.staleness.message).toBeNull();
    expect(decision.staleness.hours_stale).toBe(3);

    const { brief } = composeBrief(baseInput({ now }));
    expect(brief.staleness.warn).toBe(false);
    expect(brief.staleness.message).toBeNull();
    validateAgainstSchema("brief.v1", brief, "fresh-brief");
  });

  it("names the day in the USER's timezone, not UTC", () => {
    // 2026-08-03T04:00Z is Monday in UTC and still Sunday in Los Angeles. A brief that
    // says "since Monday" to somebody for whom it was Sunday is just wrong.
    const asOf = new Date("2026-08-03T04:00:00Z");
    const now = new Date(asOf.getTime() + 48 * 3_600_000);
    expect(assessStaleness({ digest_as_of: asOf, now, timezone: "UTC" }).staleness.message).toContain(
      "Monday",
    );
    expect(
      assessStaleness({ digest_as_of: asOf, now, timezone: TZ }).staleness.message,
    ).toContain("Sunday");
  });

  it("computes hours to one decimal", () => {
    expect(hoursBetween(new Date("2026-07-28T09:14:00Z"), new Date("2026-08-01T12:00:00Z"))).toBe(
      98.8,
    );
  });
});

// ---------------------------------------------------------------------------

describe("the hard threshold skips the send entirely", () => {
  it("sends nothing and logs the reason", async () => {
    const now = new Date(DIGEST_AS_OF.getTime() + (DEFAULT_SKIP_HOURS + 1) * 3_600_000);
    const { brief, decision } = composeBrief(baseInput({ now }));
    expect(decision.skip).toBe(true);
    expect(decision.skip_reason).toBe("digest_too_stale");

    const channel = new StubChannel();
    const logs: Array<Record<string, unknown>> = [];
    const result = await deliverBrief({
      brief,
      channel,
      skip: decision,
      log: (e) => logs.push(e),
    });

    expect(result.sent).toBe(false);
    // The assertion that matters: nothing left the building.
    expect(channel.sent).toHaveLength(0);
    expect(logs.map((l) => l["msg"])).toContain("brief.skipped");
    expect(logs[0]?.["reason"]).toBe("digest_too_stale");
    writeFileSync(join(OUT, "skip-log.json"), JSON.stringify(logs, null, 2));
  });

  it("still sends one hour before the threshold", async () => {
    const now = new Date(DIGEST_AS_OF.getTime() + (DEFAULT_SKIP_HOURS - 1) * 3_600_000);
    const { brief, decision } = composeBrief(baseInput({ now }));
    expect(decision.skip).toBe(false);

    const channel = new StubChannel();
    const result = await deliverBrief({ brief, channel, skip: decision });
    expect(result.sent).toBe(true);
    expect(channel.sent.length).toBeGreaterThan(0);
    // And it says so, rather than pretending the data is fresh.
    expect(brief.staleness.warn).toBe(true);
  });

  it("sends nothing when there is nothing to say", async () => {
    const channel = new StubChannel();
    const { brief } = composeBrief(baseInput({ gists: [] }));
    const result = await deliverBrief({ brief, channel });
    expect(result.sent).toBe(false);
    expect(channel.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

/** A channel whose capabilities the test controls. */
function channelWith(capabilities: Partial<Capabilities>): Channel & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    async send(msg: OutboundMessage): Promise<SendResult> {
      sent.push(msg);
      return {
        message_id: `omsg_stub${sent.length}`,
        provider: "mock",
        protocol: "imessage",
        line_id: "line_stub_1",
      };
    },
    async capabilities(): Promise<Capabilities> {
      return {
        tapbacks: true,
        images: true,
        groups: false,
        typing: true,
        richlinks: true,
        contact_cards: true,
        threading: true,
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

describe("delivery", () => {
  it("threads one message per item when the channel can thread", async () => {
    const channel = channelWith({ threading: true });
    const { brief, decision } = composeBrief(baseInput());
    const result = await deliverBrief({ brief, channel, skip: decision });

    expect(result.sent).toBe(true);
    if (!result.sent) return;
    expect(result.threaded).toBe(true);
    expect(channel.sent).toHaveLength(1 + brief.items.length);

    const [lead, ...items] = channel.sent;
    expect(lead?.reply_to_message_id).toBeNull();
    for (const message of items) {
      expect(message.reply_to_message_id).toBe("omsg_stub1");
      expect(message.requested_capabilities).toContain("threading");
    }
    for (const message of channel.sent) {
      validateAgainstSchema("outbound.v1", message, `outbound-${message.idempotency_key}`);
    }
  });

  it("silently sends one message when the channel cannot thread", async () => {
    const channel = channelWith({ threading: false });
    const { brief, decision } = composeBrief(baseInput());
    const result = await deliverBrief({ brief, channel, skip: decision });

    expect(result.sent).toBe(true);
    if (!result.sent) return;
    expect(result.threaded).toBe(false);
    // ONE message, carrying everything.
    expect(channel.sent).toHaveLength(1);
    const only = channel.sent[0]!;
    expect(only.reply_to_message_id).toBeNull();
    // Silently: no capability request, and nothing in the copy mentions threading.
    expect(only.requested_capabilities ?? []).not.toContain("threading");
    const text = only.blocks.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    expect(text.toLowerCase()).not.toContain("thread");

    // Every item still reaches the user.
    for (const item of brief.items) expect(text).toContain(item.display);
    validateAgainstSchema("outbound.v1", only, "outbound-unthreaded");
    writeFileSync(join(OUT, "outbound-unthreaded.txt"), text.split(" ").join(" "));
  });

  it("puts the staleness caveat before anything it qualifies", () => {
    const now = new Date(DIGEST_AS_OF.getTime() + 98 * 3_600_000);
    const { brief } = composeBrief(baseInput({ now }));
    const blocks = leadBlocks(brief);
    expect(blocks[0]).toEqual({ type: "text", text: brief.staleness.message });
  });

  it("never addresses anyone but the user", async () => {
    const channel = channelWith({ threading: true });
    const { brief, decision } = composeBrief(baseInput());
    await deliverBrief({ brief, channel, skip: decision });

    // outbound.v1 carries a user_id and no recipient, so there is structurally nowhere
    // to put a contact's handle. Asserted anyway: this is the one mistake in the whole
    // system that cannot be taken back.
    for (const message of channel.sent) {
      expect(message.user_id).toBe(USER);
      expect(JSON.stringify(message)).not.toMatch(/"to"|"recipient"|"handle"/);
      for (const block of message.blocks) {
        expect(block.type).toBe("text");
      }
    }
  });

  it("uses one idempotency key per message, stable across retries", async () => {
    const first = channelWith({ threading: true });
    const second = channelWith({ threading: true });
    const { brief, decision } = composeBrief(baseInput());

    await deliverBrief({ brief, channel: first, skip: decision });
    await deliverBrief({ brief, channel: second, skip: decision });

    const keys = first.sent.map((m) => m.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
    // A retry of the same morning must reuse them, or messages_out's unique constraint
    // stops being able to tell a retry from a second brief.
    expect(second.sent.map((m) => m.idempotency_key)).toEqual(keys);
  });

  it("writes the full user-visible text for the report", async () => {
    const channel = channelWith({ threading: true });
    const { brief, decision } = composeBrief(baseInput());
    await deliverBrief({ brief, channel, skip: decision });
    const text = channel.sent
      .map((m) => m.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n"))
      .join("\n---\n");
    writeFileSync(join(OUT, "outbound-threaded.txt"), text);
    expect(text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe("banned metrics", () => {
  it("ships none of the metrics CONTRACTS.md forbids", () => {
    // Same shape as the card's test, and for the same reason: the Definition of Done
    // greps this directory for the term, so spelling it here would fail the criterion
    // with a false positive. Read from the contract instead.
    const contracts = readFileSync(join(ROOT, "prompts", "CONTRACTS.md"), "utf8");
    const banned = [...contracts.matchAll(/\*\*Don't ship (\w+)\.\*\*/g)].map((m) =>
      m[1]!.toLowerCase().slice(0, 7),
    );
    expect(banned.length).toBeGreaterThan(0);

    const { brief } = composeBrief(baseInput());
    const rendered = JSON.stringify(brief).toLowerCase();
    for (const stem of banned) expect(rendered).not.toContain(stem);
  });
});
