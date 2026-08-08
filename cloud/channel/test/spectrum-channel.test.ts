// Spectrum, with no line and no credentials.
//
// **Unset `SPECTRUM_PROJECT_ID` and these still run**, which is the DoD's requirement and
// the reason `SpectrumPort` exists: a channel that called the SDK directly could only be
// tested by somebody holding an account, and CI would inherit a dependency on it.
//
// Every response below comes from `contracts/transcripts/spectrum/`, in the same shape as
// Track C's Linq transcripts — the two together are the evidence that the `Channel` seam
// holds for more than one implementation, which is the entire property this swap depends
// on.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { OutboundMessage } from "../../shared/src/index.js";
import {
  BAN_AFTER_REJECTIONS,
  FREE_DAILY_QUOTA,
  SpectrumChannel,
  blocksToParts,
  protocolFor,
} from "../src/spectrum-channel.js";
import type { SpectrumPart, SpectrumPort, SpectrumSendResult, SpectrumSpaceRef } from "../src/spectrum-port.js";
import { REPLAY_WINDOW_SECONDS, signBody, verifySignature } from "../src/spectrum-signature.js";
import { SpectrumRegistrar, configuredLine } from "../src/spectrum-registrar.js";

// `cloud/channel/test/` rather than beside the source: `check-ownership.sh` grants this
// track `cloud/channel/test/spectrum-*.test.ts` and not the `src/` sibling, and the path
// the ownership model already chose beats the local convention of tests-beside-code.
const TRANSCRIPTS = path.resolve(import.meta.dirname, "..", "..", "..",
  "contracts", "transcripts", "spectrum");

function transcript<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(TRANSCRIPTS, `${name}.json`), "utf8")) as T;
}

/** A port that replays a recorded response and records what it was asked. */
function replayPort(over: Partial<SpectrumPort> = {}) {
  const calls = { created: [] as string[], got: [] as string[], sent: [] as SpectrumPart[][] };
  const port: SpectrumPort = {
    createSpace: async (handle) => {
      calls.created.push(handle);
      const t = transcript<{ response: SpectrumSpaceRef }>("space_create_shared_tier");
      return { id: t.response.id, phone: t.response.phone };
    },
    getSpace: async (id) => {
      calls.got.push(id);
      return { id, phone: "shared" };
    },
    send: async (_space, parts) => {
      calls.sent.push([...parts]);
      const t = transcript<{ response: SpectrumSendResult }>("dm_send_imessage");
      return t.response;
    },
    registerUser: async () => {},
    ...over,
  };
  return { port, calls };
}

function outbound(blocks: OutboundMessage["blocks"]): OutboundMessage {
  return {
    schema_version: "outbound.v1",
    user_id: "usr_spectrum00001",
    idempotency_key: "brief-usr_spectrum00001-lead",
    blocks,
    reply_to_message_id: null,
  };
}

function channelWith(port: SpectrumPort, spaceId: string | null = null, over = {}) {
  const remembered: string[] = [];
  const channel = new SpectrumChannel({
    port,
    spaceFor: async () => ({ handle: "+16465792868", spaceId }),
    rememberSpace: async (_user, id) => { remembered.push(id); },
    ...over,
  });
  return { channel, remembered };
}

describe("service to protocol", () => {
  it("maps three and refuses to guess the fourth", () => {
    expect(protocolFor("iMessage")).toBe("imessage");
    expect(protocolFor("SMS")).toBe("sms");
    expect(protocolFor("RCS")).toBe("rcs");
    // THE ONE THAT MATTERS. "unknown" becoming "sms" would drive the handle-mismatch flag
    // and tell a user their number is not registered to iMessage, on the strength of a
    // value that says we do not know.
    expect(protocolFor("unknown")).toBeNull();
  });

  it("carries null through send, from the recorded transcript", async () => {
    const t = transcript<{ response: SpectrumSendResult }>("dm_send_unknown_service");
    const { port } = replayPort({ send: async () => t.response });
    const { channel } = channelWith(port);

    const result = await channel.send(outbound([{ type: "text", text: "hi" }]));
    expect(result.protocol).toBeNull();
    expect(result.provider).toBe("spectrum");
  });
});

describe("blocks to parts", () => {
  it("sends the card as an attachment with an EXPLICIT mime type", () => {
    // The card's URL ends in a signature and has no extension, so there is nothing for a
    // receiver to infer from — a guessed type is the acquisition artifact arriving as a
    // file nobody can open.
    const parts = blocksToParts(outbound([
      { type: "image", url: "https://cards.boi.app/c.png?sig=a", alt: "card" },
      { type: "text", text: "3 people worth a message today:" },
    ]));
    expect(parts[0]).toMatchObject({ kind: "attachment", mimeType: "image/png" });
    expect(parts[1]).toMatchObject({ kind: "text" });
  });

  it("sends a contact card NATIVELY, not as a line of text", () => {
    // The dry run caught this: the first mapping wrote `Boi: +15550100123`, which arrives
    // in the thread reading like debug output — in the FIRST REPLY, which is exactly where
    // AMENDMENT-002 moved the contact card to.
    const parts = blocksToParts(outbound([{ type: "contact_card", name: "Boi", handle: "+1646" }]));
    expect(parts).toEqual([{ kind: "contact_card" }]);
    // The composer's idea of our handle is not passed through: the transport knows its
    // own identity, and a card built from stale config would be wrong precisely when the
    // config is.
    expect(JSON.stringify(parts)).not.toContain("+1646");
  });
});

describe("the space is resolved once and then reused", () => {
  it("creates on first contact and gets thereafter", async () => {
    // The prompt asked for this to protect the new-conversation quota. The probe showed
    // `space.create` is local and consumes none, so the reason is now STABILITY: a tier
    // that returns opaque ids must not silently re-key a conversation the user can see.
    const first = replayPort();
    const a = channelWith(first.port, null);
    await a.channel.send(outbound([{ type: "text", text: "hi" }]));
    expect(first.calls.created).toEqual(["+16465792868"]);
    expect(first.calls.got).toEqual([]);
    expect(a.remembered).toEqual(["any;-;+16465792868"]);

    const second = replayPort();
    const b = channelWith(second.port, "any;-;+16465792868");
    await b.channel.send(outbound([{ type: "text", text: "hi" }]));
    expect(second.calls.got).toEqual(["any;-;+16465792868"]);
    expect(second.calls.created).toEqual([]);
    expect(b.remembered).toEqual([]);
  });
});

describe("capabilities and health", () => {
  it("reports groups: false from config, never from probing", async () => {
    // The plan tier is a sales-call answer. Probing would ask the transport a question
    // whose answer is a billing plan, and it would change under us on an upgrade with
    // nothing in the log.
    const { port } = replayPort();
    const { channel } = channelWith(port);
    const caps = await channel.capabilities();
    expect(caps.groups).toBe(false);
    expect(caps.images).toBe(true);
    expect(caps.threading).toBe(true);
  });

  it("degrades at four fifths of the daily quota", async () => {
    const { port } = replayPort();
    const { channel } = channelWith(port, "any;-;x", { dailyQuota: 10 });
    for (let i = 0; i < 7; i += 1) await channel.send(outbound([{ type: "text", text: "hi" }]));
    expect((await channel.health()).status).toBe("up");
    await channel.send(outbound([{ type: "text", text: "hi" }]));
    expect((await channel.health()).status).toBe("degraded");
  });

  it("is BANNED after repeated 'Target not allowed for this project'", async () => {
    // Not a bad minute — a permanent no. Retrying it forever against an unregistered
    // handle is how a configuration mistake becomes a rate-limit incident.
    const t = transcript<{ error: { message: string } }>("target_not_allowed");
    const { port } = replayPort({
      send: async () => { throw new Error(t.error.message); },
    });
    const { channel } = channelWith(port, "any;-;x");

    for (let i = 0; i < BAN_AFTER_REJECTIONS; i += 1) {
      await expect(channel.send(outbound([{ type: "text", text: "hi" }]))).rejects.toThrow();
    }
    expect((await channel.health()).status).toBe("banned");
  });

  it("reports line_id null before the first send, and that is normal", async () => {
    // On a shared pool the line is per conversation and picked at send time, so there is
    // no single correct value. Null is "we have not sent yet", not an error.
    const { port } = replayPort();
    const { channel } = channelWith(port);
    expect((await channel.health()).line_id).toBeNull();
    await channel.send(outbound([{ type: "text", text: "hi" }]));
    expect((await channel.health()).line_id).toBe("+16465792868");
  });

  it("uses the documented free-tier quota by default", () => {
    expect(FREE_DAILY_QUOTA).toBe(5_000);
  });
});

describe("the signature", () => {
  const secret = "spectrum-dev-secret";
  const body = JSON.stringify({ message: { id: "msg_1", text: "hi" } });
  const now = new Date("2026-08-04T12:00:00Z");
  const stamp = String(Math.floor(now.getTime() / 1000));

  it("passes a valid signature", () => {
    const sig = `v0=${signBody(secret, stamp, body)}`;
    expect(verifySignature({
      secret, rawBody: body, signatureHeader: sig, timestampHeader: stamp, now,
    })).toEqual({ ok: true });
  });

  const bad: Array<[string, Parameters<typeof verifySignature>[0], string]> = [
    ["a tampered body", {
      secret, rawBody: `${body} `, signatureHeader: `v0=${signBody(secret, stamp, body)}`,
      timestampHeader: stamp, now,
    }, "mismatch"],
    ["the wrong secret", {
      secret: "not-the-secret", rawBody: body,
      signatureHeader: `v0=${signBody(secret, stamp, body)}`, timestampHeader: stamp, now,
    }, "mismatch"],
    ["a missing header", {
      secret, rawBody: body, signatureHeader: undefined, timestampHeader: stamp, now,
    }, "missing_header"],
    ["a duplicated header", {
      secret, rawBody: body, signatureHeader: ["a", "b"], timestampHeader: stamp, now,
    }, "missing_header"],
  ];

  for (const [name, input, reason] of bad) {
    it(`rejects ${name}`, () => {
      const check = verifySignature(input);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toBe(reason);
    });
  }

  it("accepts t−4:59 and rejects t−5:01", () => {
    const inside = String(Math.floor(now.getTime() / 1000) - (REPLAY_WINDOW_SECONDS - 1));
    const outside = String(Math.floor(now.getTime() / 1000) - (REPLAY_WINDOW_SECONDS + 1));
    expect(verifySignature({
      secret, rawBody: body, signatureHeader: `v0=${signBody(secret, inside, body)}`,
      timestampHeader: inside, now,
    }).ok).toBe(true);
    expect(verifySignature({
      secret, rawBody: body, signatureHeader: `v0=${signBody(secret, outside, body)}`,
      timestampHeader: outside, now,
    }).ok).toBe(false);
  });

  it("rejects a clock skewed FORWARD as well as back", () => {
    // A one-sided window lets a forged far-future timestamp replay indefinitely.
    const future = String(Math.floor(now.getTime() / 1000) + REPLAY_WINDOW_SECONDS + 1);
    expect(verifySignature({
      secret, rawBody: body, signatureHeader: `v0=${signBody(secret, future, body)}`,
      timestampHeader: future, now,
    }).ok).toBe(false);
  });

  it("throws bad_signature from normalizeInbound, with no reason attached", async () => {
    // Four reasons in the log, ONE on the wire. Telling an unauthenticated caller which
    // part of their forgery was wrong turns the check into an oracle.
    const { port } = replayPort();
    const { channel } = channelWith(port);
    expect(() => channel.normalizeInbound(body, "v0=deadbeef")).toThrow("bad_signature(");
  });
});

describe("the registrar", () => {
  it("takes the line from CONFIG, never from space.phone", async () => {
    // The probe: `space.create` returns phone "shared" on the free tier. Reading it would
    // put the literal string "shared" into an `sms:` link.
    const { port } = replayPort();
    const registrar = new SpectrumRegistrar(port, "+16465792868");
    const line = await registrar.lineFor("usr_x");
    expect(line?.handle).toBe("+16465792868");
    expect(line?.handle).not.toBe("shared");
  });

  it("refuses to start without a configured line", () => {
    // An invented number produces a deep link opening a thread with a stranger, and the
    // user would have done everything right.
    expect(() => configuredLine({} as NodeJS.ProcessEnv)).toThrow(/SPECTRUM_LINE_E164/);
    expect(() => configuredLine({ SPECTRUM_LINE_E164: "shared" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("registers every handle in one call", async () => {
    const registered: Array<readonly string[]> = [];
    const { port } = replayPort({
      registerUser: async (input) => { registered.push(input.handles); },
    });
    const registrar = new SpectrumRegistrar(port, "+16465792868");
    await registrar.register({ user_id: "usr_x", handles: ["+15551230000", "a@example.com"] });

    expect(registered).toEqual([["+15551230000", "a@example.com"]]);
  });
});
