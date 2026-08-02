// The zod schemas, checked against the frozen JSON Schemas rather than against my
// memory of them. No database.
//
// This file exists because of the defect this track already shipped once: three places
// independently spelled the same id constraint, all three agreed with each other, and
// all three disagreed with `contracts/schema/`. Anything with a number in it is read
// from the contract here.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { digestSchema, heartbeatSchema, isoUtc, voicePackSchema } from "./schemas.js";
import { ID_PATTERNS, VOICE_PACK_LIMITS } from "./contract-limits.js";
import {
  findRedactionViolations,
  findViolationsInStrings,
  freeTextFields,
  describeViolations,
} from "./redaction.js";
import type { VoicePack } from "@boi/shared";

const ROOT = process.cwd();
const SCHEMA_DIR = join(ROOT, "contracts", "schema");
const FIXTURE_DIR = join(ROOT, "contracts", "fixtures");

function schema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")) as Record<string, unknown>;
}

function fixtures(kind: string): Array<{ name: string; doc: unknown }> {
  return readdirSync(join(FIXTURE_DIR, kind))
    .filter((f) => f.endsWith(".json"))
    .map((name) => ({
      name,
      doc: JSON.parse(readFileSync(join(FIXTURE_DIR, kind, name), "utf8")) as unknown,
    }));
}

describe("the limits come from the contract, not from this repository's memory", () => {
  it("reads exemplar bounds out of voice_pack.v1.json", () => {
    const vp = schema("voice_pack.v1.json");
    const props = vp["properties"] as Record<string, Record<string, unknown>>;
    const exemplars = props["exemplars"]!;
    const items = exemplars["items"] as Record<string, unknown>;

    expect(VOICE_PACK_LIMITS.maxExemplars).toBe(exemplars["maxItems"]);
    expect(VOICE_PACK_LIMITS.maxExemplarChars).toBe(items["maxLength"]);
    expect(VOICE_PACK_LIMITS.minExemplarChars).toBe(items["minLength"]);
    // Sanity: if the contract ever loses these, the assertions above pass vacuously.
    expect(typeof VOICE_PACK_LIMITS.maxExemplars).toBe("number");
    expect(VOICE_PACK_LIMITS.maxExemplars).toBeGreaterThan(0);
  });

  it("reads id patterns out of digest.v1.json", () => {
    const d = schema("digest.v1.json");
    const props = d["properties"] as Record<string, Record<string, unknown>>;
    expect(ID_PATTERNS.user.source).toBe(props["user_id"]!["pattern"]);
    expect(ID_PATTERNS.device.source).toBe(props["device_id"]!["pattern"]);
  });
});

describe("every committed fixture parses", () => {
  it("accepts all digest fixtures", () => {
    for (const { name, doc } of fixtures("digest")) {
      const result = digestSchema.safeParse(doc);
      expect(result.success, `${name}: ${result.success ? "" : result.error.message}`).toBe(true);
    }
  });

  it("accepts all voice pack fixtures", () => {
    for (const { name, doc } of fixtures("voice_pack")) {
      const result = voicePackSchema.safeParse(doc);
      expect(result.success, `${name}: ${result.success ? "" : result.error.message}`).toBe(true);
    }
  });
});

describe("the zod schemas enforce what the JSON Schemas enforce", () => {
  const base = () =>
    JSON.parse(
      readFileSync(join(FIXTURE_DIR, "voice_pack", "maya.json"), "utf8"),
    ) as Record<string, unknown>;

  it("rejects exactly one exemplar past maxItems", () => {
    const pack = base();
    pack["exemplars"] = Array.from({ length: VOICE_PACK_LIMITS.maxExemplars }, () => "ok");
    expect(voicePackSchema.safeParse(pack).success).toBe(true);

    pack["exemplars"] = Array.from({ length: VOICE_PACK_LIMITS.maxExemplars + 1 }, () => "ok");
    expect(voicePackSchema.safeParse(pack).success).toBe(false);
  });

  it("rejects exactly one character past maxLength", () => {
    const pack = base();
    pack["exemplars"] = ["a".repeat(VOICE_PACK_LIMITS.maxExemplarChars)];
    expect(voicePackSchema.safeParse(pack).success).toBe(true);

    pack["exemplars"] = ["a".repeat(VOICE_PACK_LIMITS.maxExemplarChars + 1)];
    expect(voicePackSchema.safeParse(pack).success).toBe(false);
  });

  it("rejects an empty exemplar, which minLength forbids", () => {
    const pack = base();
    pack["exemplars"] = [""];
    expect(voicePackSchema.safeParse(pack).success).toBe(false);
  });

  it("rejects a voice_pack_version outside the frozen pattern", () => {
    const pack = base();
    for (const bad of ["vp_NOTHEX01", "vp_short", "4a91cc02", "vp_4a91cc02extra12345"]) {
      pack["voice_pack_version"] = bad;
      expect(voicePackSchema.safeParse(pack).success, bad).toBe(false);
    }
  });

  it("rejects an unknown top-level field", () => {
    const pack = base();
    pack["exfiltrated"] = "surprise";
    expect(voicePackSchema.safeParse(pack).success).toBe(false);
  });

  it("rejects a contact_id in the wrong alphabet", () => {
    const pack = base();
    pack["contact_id"] = "h_NOTHEXXX";
    expect(voicePackSchema.safeParse(pack).success).toBe(false);
  });
});

describe("timestamps are ISO 8601 UTC with a Z, per § 6", () => {
  it("accepts a Z timestamp", () => {
    expect(isoUtc.safeParse("2026-08-01T09:14:00Z").success).toBe(true);
    expect(isoUtc.safeParse("2026-08-01T09:14:00.123Z").success).toBe(true);
  });

  it("rejects an offset, a naive timestamp, and an epoch integer", () => {
    for (const bad of ["2026-08-01T09:14:00+00:00", "2026-08-01T09:14:00", "1754039640"]) {
      expect(isoUtc.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("the heartbeat body matches the OpenAPI document", () => {
  it("requires device_id, app_version and digest_as_of", () => {
    expect(heartbeatSchema.safeParse({}).success).toBe(false);
    expect(
      heartbeatSchema.safeParse({ device_id: "dev_abcdefgh", app_version: "1" }).success,
    ).toBe(false);
  });

  it("accepts the documented optional fields and rejects anything else", () => {
    const ok = {
      device_id: "dev_abcdefgh",
      app_version: "0.1.0",
      digest_as_of: "2026-08-01T09:14:00Z",
      macos_version: "26.0",
      fda_granted: false,
    };
    expect(heartbeatSchema.safeParse(ok).success).toBe(true);
    expect(heartbeatSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe("the redaction guard", () => {
  function packWith(over: Record<string, unknown>): VoicePack {
    const base = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "voice_pack", "maya.json"), "utf8"),
    ) as VoicePack;
    return { ...base, ...over } as VoicePack;
  }

  it("passes every committed voice-pack fixture", () => {
    for (const { name, doc } of fixtures("voice_pack")) {
      expect(findRedactionViolations(doc as VoicePack), name).toEqual([]);
    }
  });

  // ONE TEST PER FREE-TEXT FIELD. The original guard scanned `exemplars` only, and
  // three per-PATTERN tests all passed while `register.apology_openers` carried a phone
  // number into storage. Per-pattern coverage cannot see a missed field; per-field can.
  const FIELD_CASES: Array<{ field: string; build: (leak: string) => VoicePack }> = [
    { field: "exemplars", build: (leak) => packWith({ exemplars: [leak] }) },
    {
      field: "register.apology_openers",
      build: (leak) =>
        packWith({
          register: {
            ...(JSON.parse(
              readFileSync(join(FIXTURE_DIR, "voice_pack", "maya.json"), "utf8"),
            ) as VoicePack).register,
            apology_openers: [leak],
          },
        }),
    },
    {
      field: "register.abbreviations",
      build: (leak) =>
        packWith({
          register: {
            ...(JSON.parse(
              readFileSync(join(FIXTURE_DIR, "voice_pack", "maya.json"), "utf8"),
            ) as VoicePack).register,
            abbreviations: [leak],
          },
        }),
    },
    {
      field: "register.top_emoji",
      build: (leak) =>
        packWith({
          register: {
            ...(JSON.parse(
              readFileSync(join(FIXTURE_DIR, "voice_pack", "maya.json"), "utf8"),
            ) as VoicePack).register,
            top_emoji: [leak],
          },
        }),
    },
  ];

  for (const { field, build } of FIELD_CASES) {
    it(`scans ${field}`, () => {
      // The exact payload from the review: spotless exemplars, a leak in one other
      // free-text array. Before the fix this returned [] for three of the four.
      const violations = findRedactionViolations(
        build("sorry i still owe you $40, call me on 415-555-0142"),
      );
      expect(violations.length, `${field} was not scanned`).toBeGreaterThan(0);
      const patterns = violations.map((v) => v.pattern);
      expect(patterns).toContain("phone");
      expect(patterns).toContain("amount");
    });
  }

  it("enumerates exactly the free-text arrays voice_pack.v1 defines", () => {
    // If a future contract adds a free-text field, this fails until it is scanned.
    const vp = schema("voice_pack.v1.json");
    const props = vp["properties"] as Record<string, Record<string, unknown>>;
    const register = props["register"]!["properties"] as Record<string, Record<string, unknown>>;

    const stringArrays = new Set<string>();
    if ((props["exemplars"]!["items"] as Record<string, unknown>)["type"] === "string") {
      stringArrays.add("exemplars");
    }
    for (const [name, def] of Object.entries(register)) {
      const items = def["items"] as Record<string, unknown> | undefined;
      if (def["type"] === "array" && items?.["type"] === "string") stringArrays.add(name);
    }

    const scanned = new Set(
      freeTextFields(
        JSON.parse(
          readFileSync(join(FIXTURE_DIR, "voice_pack", "maya.json"), "utf8"),
        ) as VoicePack,
      ).map((f) => f.field as string),
    );
    for (const name of stringArrays) {
      expect(scanned, `voice_pack.v1 defines free-text ${name} and the guard skips it`)
        .toContain(name);
    }
  });

  it("catches phone numbers in the shapes people actually write", () => {
    for (const s of [
      "call me on 415-555-0142",
      "my number is (415) 555 0142",
      "+1 415 555 0142 works",
      "ring 4155550142",
    ]) {
      expect(findViolationsInStrings([s]), s).toContain("phone");
    }
  });

  it("catches email addresses", () => {
    expect(findViolationsInStrings(["send it to maya.chen+tag@example.co.uk"])).toContain(
      "email",
    );
  });

  it("catches amounts in several currencies and spellings", () => {
    for (const s of ["i owe u $40", "that was $1,200.50", "40 dollars", "£25 each", "30 usd"]) {
      expect(findViolationsInStrings([s]), s).toContain("amount");
    }
  });

  it("catches street addresses without relying on capitalisation", () => {
    // § 7: the target corpus is lowercase texting. A pattern requiring [A-Z] passes
    // every test written against capitalised samples and leaks the real thing.
    for (const s of [
      "742 Evergreen Terrace",
      "meet at 10 downing st",
      "1600 pennsylvania ave",
    ]) {
      expect(findViolationsInStrings([s]), s).toContain("street_address");
    }
  });

  it("does not fire on ordinary redacted chat", () => {
    for (const s of [
      "sorry been mia this week, work has been insane",
      "omg yes im so down. what day were u thinking",
      "ok that works for me",
      "see u at 8",
      "lmk when ur free and ill come thru",
      "prob gonna be late but ill be there",
    ]) {
      expect(findViolationsInStrings([s]), s).toEqual([]);
    }
  });

  it("reports every violation across every field, not just the first", () => {
    const base = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "voice_pack", "maya.json"), "utf8"),
    ) as VoicePack;
    const violations = findRedactionViolations({
      ...base,
      exemplars: ["clean one", "call 415-555-0142"],
      register: { ...base.register, apology_openers: ["sorry, i owe u $40"] },
    } as VoicePack);
    expect(new Set(violations.map((v) => v.field))).toEqual(
      new Set(["exemplars", "apology_openers"]),
    );
  });

  it("describes violations without repeating the offending text", () => {
    const base = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "voice_pack", "maya.json"), "utf8"),
    ) as VoicePack;
    const leak = "call me on 415-555-0142";
    const detail = describeViolations(
      findRedactionViolations({ ...base, exemplars: [leak] } as VoicePack),
    );
    expect(detail).toContain("phone");
    expect(detail).toContain("exemplars");
    expect(detail).not.toContain("415-555-0142");
  });
});
