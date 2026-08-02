import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../../shared/src/contracts.js";
import { LinqChannel, loadLinqChannelConfig, extractLinqWebhook, type LinqChannelConfig } from "./linq-channel.js";
import {
  hmacSha256Verifier,
  InboundParseError,
  SignatureError,
  normalizeInbound,
  type SignatureVerifier,
} from "./inbound.js";

const REPO_ROOT = new URL("../../../", import.meta.url);
const SECRET = "dev-secret-change-me";
const SCRATCH = "/tmp/boi-c";

const REFERENCE = JSON.parse(
  readFileSync(new URL("contracts/transcripts/linq/inbound_webhook.json", REPO_ROOT), "utf8"),
) as { body: Record<string, unknown> };

const DRAFT_CHOICE_2 = JSON.parse(
  readFileSync(new URL("contracts/fixtures/inbound/draft_choice_2.json", REPO_ROOT), "utf8"),
) as InboundMessage;

function sign(raw: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

function channel(
  overrides: Partial<LinqChannelConfig> = {},
  deps: { verifier?: SignatureVerifier; resolveUser?: (h: string) => string | null } = {},
): LinqChannel {
  return new LinqChannel(
    { ...loadLinqChannelConfig({ LINQ_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv), ...overrides },
    { resolveHandles: () => ["+15551234567"], ...deps },
  );
}

describe("inbound — the reference body", () => {
  const raw = JSON.stringify(REFERENCE.body);

  it("normalizes and validates against contracts/schema/inbound.v1.json", () => {
    const message = channel().normalizeInbound(raw, sign(raw));

    mkdirSync(SCRATCH, { recursive: true });
    const out = `${SCRATCH}/inbound-reference.json`;
    writeFileSync(out, JSON.stringify(message, null, 2));

    // The real validator, not a re-implementation of it in the test.
    const result = execFileSync(
      "python3",
      [fileURLToPath(new URL("scripts/validate_fixtures.py", REPO_ROOT)), "inbound.v1", out],
      { encoding: "utf8" },
    );
    expect(result).toMatch(/OK/);
  });

  it("matches draft_choice_2.json on every field it can, and pins the three it cannot", () => {
    // The DoD allows two exceptions: provider_message_id and timestamps. There are three
    // more, and none is a normalization bug — see NOTES.md "Contract gaps".
    //   provider  — the fixture says "mock"; a Linq webhook is "linq". Configurable, so
    //               this test sets it and the field genuinely matches.
    //   user_id   — the fixture says "usr_demo0001"; pairing resolves that and pairing is
    //               Track D's. Injectable, so this test supplies it.
    //   reply_to_message_id — the fixture says "omsg_9001" (Boi's own outbound id); the
    //               webhook carries "lmsg_01J8ZK" (the PROVIDER's id). Translating one to
    //               the other needs a lookup this track does not own. IRREDUCIBLE.
    const message = channel(
      { providerLabel: "mock" },
      { resolveUser: (handle) => (handle === "+15551234567" ? "usr_demo0001" : null) },
    ).normalizeInbound(raw, sign(raw));

    const IGNORED = new Set(["provider_message_id", "received_at", "reply_to_message_id"]);
    for (const key of Object.keys(DRAFT_CHOICE_2)) {
      if (IGNORED.has(key)) continue;
      expect(message[key as keyof InboundMessage], key).toEqual(DRAFT_CHOICE_2[key as keyof InboundMessage]);
    }
    expect(Object.keys(message).sort()).toEqual(Object.keys(DRAFT_CHOICE_2).sort());

    // Pin the divergence rather than merely excluding it, so a silent change is caught.
    expect(message.provider_message_id).toBe("lmsg_01J8ZM");
    expect(message.received_at).toBe("2026-08-02T12:04:02Z");
    expect(message.reply_to_message_id).toBe("lmsg_01J8ZK");
    expect(DRAFT_CHOICE_2.reply_to_message_id).toBe("omsg_9001");
  });

  it("defaults to provider linq and user_id null", () => {
    const message = channel().normalizeInbound(raw, sign(raw));
    expect(message.provider).toBe("linq");
    expect(message.user_id).toBeNull();
  });
});

describe("inbound — verification", () => {
  const raw = JSON.stringify(REFERENCE.body);

  it("a wrong signature throws, distinguishably from a parse error", () => {
    const c = channel();
    const badSig = (): unknown => {
      try {
        c.normalizeInbound(raw, sign(raw, "not-the-secret"));
      } catch (e) {
        return e;
      }
      return null;
    };
    const badBody = (): unknown => {
      const junk = "{not json";
      try {
        c.normalizeInbound(junk, sign(junk));
      } catch (e) {
        return e;
      }
      return null;
    };

    expect(badSig()).toBeInstanceOf(SignatureError);
    expect(badBody()).toBeInstanceOf(InboundParseError);
    // Distinguishable both by class and by code — a caller that alerts on forged
    // signatures must not be woken by a schema change.
    expect((badSig() as SignatureError).code).toBe("bad_signature");
    expect((badBody() as InboundParseError).code).toBe("malformed_inbound");
    expect(badBody()).not.toBeInstanceOf(SignatureError);
  });

  it("a missing or empty signature throws rather than passing", () => {
    const c = channel();
    for (const sig of ["", "sha256=", "garbage", "sha256=00"]) {
      expect(() => c.normalizeInbound(raw, sig), sig).toThrow(SignatureError);
    }
  });

  it("key reordering does not break verification — the RAW bytes are what is signed", () => {
    // Same document, different key order and whitespace. Signing the bytes that arrived
    // must still verify; a verifier that re-serialized the parsed object would compare
    // against a normalized form and reject this.
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(REFERENCE.body).reverse()),
      null,
      2,
    );
    expect(reordered).not.toBe(raw);
    expect(JSON.parse(reordered)).toEqual(REFERENCE.body);

    const message = channel().normalizeInbound(reordered, sign(reordered));
    expect(message.provider_message_id).toBe("lmsg_01J8ZM");

    // And the negative: a signature over the canonical form does NOT verify the
    // reordered bytes. If it did, something in the path is re-serializing.
    expect(() => channel().normalizeInbound(reordered, sign(raw))).toThrow(SignatureError);
  });

  it("refuses an already-parsed object rather than re-serializing to verify it", () => {
    expect(() => channel().normalizeInbound(REFERENCE.body, sign(raw))).toThrow(/raw body required/);
  });

  it("accepts a Buffer as well as a string", () => {
    const buf = Buffer.from(raw, "utf8");
    expect(channel().normalizeInbound(buf, sign(raw)).provider_message_id).toBe("lmsg_01J8ZM");
  });

  it("comparison is constant-time — the implementation calls crypto.timingSafeEqual", () => {
    const source = readFileSync(fileURLToPath(new URL("cloud/channel/src/inbound.ts", REPO_ROOT)), "utf8");
    expect(source).toContain("return timingSafeEqual(expected, actual);");
    expect(typeof timingSafeEqual).toBe("function");
  });

  it("the verifier is swappable — an injected strategy is the one used", () => {
    const calls: string[] = [];
    const alwaysYes: SignatureVerifier = {
      name: "test-always-yes",
      verify(_body, signature) {
        calls.push(signature);
        return true;
      },
    };
    // A signature the real HMAC verifier would reject outright.
    const message = channel({}, { verifier: alwaysYes }).normalizeInbound(raw, "scheme-we-have-not-seen");
    expect(calls).toEqual(["scheme-we-have-not-seen"]);
    expect(message.provider_message_id).toBe("lmsg_01J8ZM");

    const alwaysNo: SignatureVerifier = { name: "test-always-no", verify: () => false };
    expect(() => channel({}, { verifier: alwaysNo }).normalizeInbound(raw, sign(raw))).toThrow(SignatureError);
  });

  it("hmacSha256Verifier rejects a wrong secret, a wrong body and a wrong prefix", () => {
    const v = hmacSha256Verifier(SECRET);
    const bytes = Buffer.from(raw, "utf8");
    expect(v.verify(bytes, sign(raw))).toBe(true);
    expect(v.verify(bytes, sign(raw, "other"))).toBe(false);
    expect(v.verify(Buffer.from('{"a":1}'), sign(raw))).toBe(false);
    expect(v.verify(bytes, sign(raw).replace("sha256=", "sha1="))).toBe(false);
  });
});

describe("inbound — all five kinds", () => {
  const base = {
    id: "lmsg_kind",
    line_id: "line_a1",
    from: "+15551234567",
    protocol: "imessage",
    received_at: "2026-08-02T12:04:02Z",
  };

  const cases: [string, Record<string, unknown>, InboundMessage["kind"], string | null, string | null][] = [
    ["text", { ...base, type: "message", text: "2" }, "text", "2", null],
    ["tapback", { ...base, type: "tapback", tapback: "love" }, "tapback", null, "love"],
    ["read_receipt", { ...base, type: "read" }, "read_receipt", null, null],
    ["delivery_receipt", { ...base, type: "delivered" }, "delivery_receipt", null, null],
    ["typing", { ...base, type: "typing" }, "typing", null, null],
  ];

  for (const [label, body, kind, text, tapback] of cases) {
    it(`normalizes ${label}`, () => {
      const raw = JSON.stringify(body);
      const message = channel().normalizeInbound(raw, sign(raw));
      expect(message.kind).toBe(kind);
      expect(message.text).toBe(text);
      expect(message.tapback).toBe(tapback);
      expect(message.schema_version).toBe("inbound.v1");
      expect(message.received_at).toBe("2026-08-02T12:04:02Z");
    });
  }

  it("all five validate against the frozen schema", () => {
    mkdirSync(SCRATCH, { recursive: true });
    for (const [label, body] of cases) {
      const raw = JSON.stringify(body);
      const out = `${SCRATCH}/inbound-${label}.json`;
      writeFileSync(out, JSON.stringify(channel().normalizeInbound(raw, sign(raw)), null, 2));
      const result = execFileSync(
        "python3",
        [fileURLToPath(new URL("scripts/validate_fixtures.py", REPO_ROOT)), "inbound.v1", out],
        { encoding: "utf8" },
      );
      expect(result, label).toMatch(/OK/);
    }
  });

  it("refuses an unknown type rather than defaulting it to text", () => {
    // Defaulting would turn provider noise into something a person appears to have said.
    const raw = JSON.stringify({ ...base, type: "carrier_pigeon", text: "hi" });
    expect(() => channel().normalizeInbound(raw, sign(raw))).toThrow(InboundParseError);
  });

  it("does not carry text on a kind that cannot have said anything", () => {
    const raw = JSON.stringify({ ...base, type: "read", text: "leftover provider noise" });
    expect(channel().normalizeInbound(raw, sign(raw)).text).toBeNull();
  });

  it("a reaction field wins over a type of message", () => {
    const raw = JSON.stringify({ ...base, type: "message", reaction: "laughed" });
    const message = channel().normalizeInbound(raw, sign(raw));
    expect(message.kind).toBe("tapback");
    expect(message.tapback).toBe("laughed");
  });
});

describe("inbound — fields", () => {
  const base = {
    id: "lmsg_f",
    line_id: "line_a1",
    from: "+15551234567",
    type: "message",
    text: "hi",
    received_at: "2026-08-02T12:04:02Z",
  };
  const send = (body: Record<string, unknown>): InboundMessage => {
    const raw = JSON.stringify(body);
    return channel().normalizeInbound(raw, sign(raw));
  };

  it("an unknown handle yields user_id null rather than an error", () => {
    const raw = JSON.stringify({ ...base, from: "+15550000000" });
    const message = channel({}, { resolveUser: (h) => (h === "+15551234567" ? "usr_demo0001" : null) }).normalizeInbound(
      raw,
      sign(raw),
    );
    expect(message.user_id).toBeNull();
    expect(message.from_handle).toBe("+15550000000");
  });

  it("passes a W3C traceparent through and drops anything that is not one", () => {
    const good = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(send({ ...base, trace_id: good }).trace_id).toBe(good);
    expect(send({ ...base, traceparent: good }).trace_id).toBe(good);
    expect(send({ ...base, trace_id: "not-a-traceparent" }).trace_id).toBeNull();
    expect(send(base).trace_id).toBeNull();
  });

  it("keeps a valid provider timestamp and stamps its own when there is none", () => {
    expect(send(base).received_at).toBe("2026-08-02T12:04:02Z");

    const raw = JSON.stringify({ ...base, received_at: "last tuesday" });
    const fixed = new Date("2026-08-02T15:00:00.000Z");
    const message = new LinqChannel(
      { ...loadLinqChannelConfig({ LINQ_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv) },
      { resolveHandles: () => [], now: () => fixed },
    ).normalizeInbound(raw, sign(raw));
    expect(message.received_at).toBe("2026-08-02T15:00:00.000Z");
  });

  it("refuses a body missing a required field rather than inventing one", () => {
    for (const missing of ["id", "line_id", "from", "type"]) {
      const body: Record<string, unknown> = { ...base };
      delete body[missing];
      const raw = JSON.stringify(body);
      expect(() => channel().normalizeInbound(raw, sign(raw)), missing).toThrow(InboundParseError);
    }
  });

  it("drops a protocol the contract does not name", () => {
    expect(send({ ...base, protocol: "carrier_pigeon" }).protocol).toBeNull();
    expect(send({ ...base, protocol: "sms" }).protocol).toBe("sms");
  });
});

describe("inbound — the normalizer is provider-neutral", () => {
  it("normalize() works with an extractor that knows nothing about Linq", () => {
    // Proves the split is real: inbound.ts carries no vendor knowledge, so a second
    // provider is a new extractor rather than a change here.
    const raw = '{"msgId":"tw_1","channel":"line_b2","sender":"+15557654321","what":"ping"}';
    const message = normalizeInbound(raw, sign(raw), {
      verifier: hmacSha256Verifier(SECRET),
      provider: "twilio",
      now: () => new Date("2026-08-02T15:00:00.000Z"),
      extract: (body) => {
        const b = body as Record<string, string>;
        return {
          providerMessageId: b.msgId ?? "",
          lineId: b.channel ?? "",
          fromHandle: b.sender ?? "",
          kind: "text",
          receivedAt: null,
          text: b.what ?? null,
          tapback: null,
          replyToMessageId: null,
          protocol: "sms",
          traceId: null,
        };
      },
    });

    expect(message.provider).toBe("twilio");
    expect(message.provider_message_id).toBe("tw_1");
    expect(message.received_at).toBe("2026-08-02T15:00:00.000Z");
  });

  it("the Linq extractor is exported and refuses a non-object", () => {
    expect(() => extractLinqWebhook("nope")).toThrow(InboundParseError);
    expect(extractLinqWebhook(REFERENCE.body).providerMessageId).toBe("lmsg_01J8ZM");
  });
});
