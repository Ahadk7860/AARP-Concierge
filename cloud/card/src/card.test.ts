// The card. No database — it takes a digest and produces an image.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Digest } from "../../shared/src/index.js";
import { buildCardServer } from "./server.js";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  CONTENT_WIDTH,
  ROW_GAP,
  ROW_SIZE,
  cardSvg,
  estimateWidth,
  fitToWidth,
  renderCard,
  wrapByWidth,
} from "./render.js";
import { buildCardModel, MAX_NAME_CHARS, truncateName } from "./model.js";
import { allCopyStrings, ARCHETYPE_LABEL, ARCHETYPE_LINE } from "./copy.js";

const FIXTURES = join(process.cwd(), "contracts", "fixtures", "digest");
const SRC = join(process.cwd(), "cloud", "card", "src");
/** CONTRACTS.md § 9 assigns this track /tmp/boi-d. Images land there for the report. */
const OUT = "/tmp/boi-d/card";

function digest(name: string): Digest {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Digest;
}

/** PNG dimensions live in the IHDR chunk, bytes 16..24. No decoder needed. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

let app: FastifyInstance;

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  app = buildCardServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------

describe("POST /render", () => {
  it("returns a PNG that is exactly 1080x1920", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/render",
      payload: digest("healthy"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");

    const png = res.rawPayload;
    const { width, height } = pngSize(png);
    expect(width).toBe(1080);
    expect(height).toBe(1920);
    // 9:16, asserted as a ratio rather than trusting two constants to stay in step.
    expect(width / height).toBeCloseTo(9 / 16, 10);

    writeFileSync(join(OUT, "healthy.png"), png);
  });

  it("rejects a digest the frozen schema rejects", async () => {
    const bad = digest("healthy") as unknown as Record<string, unknown>;
    (bad["corpus"] as Record<string, unknown>)["health"] = "excellent";
    const res = await app.inject({ method: "POST", url: "/render", payload: bad });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("validation");
  });

  it("renders the healthy fixture in under two seconds", async () => {
    const started = process.hrtime.bigint();
    renderCard(digest("healthy"));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(2000);
  });
});

describe("determinism", () => {
  it("renders the same digest to byte-identical output", () => {
    const a = renderCard(digest("healthy")).png;
    const b = renderCard(digest("healthy")).png;
    expect(a.length).toBe(b.length);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("renders identical output through the HTTP surface too", async () => {
    const one = await app.inject({ method: "POST", url: "/render", payload: digest("healthy") });
    const two = await app.inject({ method: "POST", url: "/render", payload: digest("healthy") });
    expect(Buffer.compare(one.rawPayload, two.rawPayload)).toBe(0);
  });

  it("orders archetypes by taxonomy, not by anything about the people", () => {
    // A different relationship order in must not mean a different card out. If the
    // order depended on message_count it would be a leaderboard, and a leaderboard
    // attaches a number to a human being.
    const forward = digest("healthy");
    const reversed = digest("healthy");
    reversed.relationships = [...reversed.relationships].reverse();
    expect(Buffer.compare(renderCard(forward).png, renderCard(reversed).png)).toBe(0);
  });
});

describe("the judgmental number", () => {
  it("is computed from the digest, not hard-coded", () => {
    const d = digest("healthy");
    const model = buildCardModel(d);
    expect(model.kind).toBe("card");
    if (model.kind !== "card") return;

    const whole = d.whole_life as unknown as {
      relationships_gone_quiet: number;
      relationships_ranked: number;
    };
    // Recomputed here from the source document rather than compared to "40%".
    const expected = `${Math.round((whole.relationships_gone_quiet / whole.relationships_ranked) * 100)}%`;
    expect(model.headline).toBe(expected);
    expect(model.gone_quiet).toBe(whole.relationships_gone_quiet);
    expect(model.ranked).toBe(whole.relationships_ranked);
    expect(model.caption).toContain(String(whole.relationships_ranked));

    // And it reaches the image.
    expect(cardSvg(model)).toContain(expected);
  });

  it("moves when the digest moves", () => {
    const d = digest("healthy");
    (d.whole_life as Record<string, unknown>)["relationships_gone_quiet"] = 5;
    const model = buildCardModel(d);
    expect(model.kind === "card" && model.headline).toBe("20%");
  });
});

describe("archetypes", () => {
  it("names at least two archetypes present in the digest", () => {
    const d = digest("healthy");
    const model = buildCardModel(d);
    expect(model.kind).toBe("card");
    if (model.kind !== "card") return;

    expect(model.archetypes.length).toBeGreaterThanOrEqual(2);

    const present = new Set(d.relationships.map((r) => r.archetype).filter(Boolean));
    for (const a of model.archetypes) {
      // Every archetype shown is one the digest actually contains — no invented labels.
      expect(present, `${a.archetype} is not in the digest`).toContain(a.archetype);
      expect(cardSvg(model)).toContain(a.label);
      expect(cardSvg(model)).toContain(a.display);
    }
  });

  it("uses only the five names CONTRACTS.md fixes", () => {
    const allowed = [
      "fade",
      "chapter",
      "one_way_enthusiasm",
      "the_one_you_keep_waiting",
      "rising_fastest",
    ];
    expect(Object.keys(ARCHETYPE_LABEL).sort()).toEqual([...allowed].sort());
    expect(Object.keys(ARCHETYPE_LINE).sort()).toEqual([...allowed].sort());
  });
});

describe("a thin digest does not get a normal card", () => {
  it("refuses, with a reason, rather than inventing a percentage", async () => {
    const d = digest("thin");
    const model = buildCardModel(d);
    expect(model.kind).toBe("refusal");
    if (model.kind !== "refusal") return;
    expect(model.reason).toBe("thin_corpus");

    const svg = cardSvg(model);
    expect(svg).toContain("not enough history yet");
    // NOTHING that looks like the real card. No percentage, no archetype labels.
    expect(svg).not.toMatch(/\d+%/);
    for (const label of Object.values(ARCHETYPE_LABEL)) {
      expect(svg).not.toContain(label);
    }

    const res = await app.inject({ method: "POST", url: "/render", payload: d });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-boi-card-kind"]).toBe("refusal");
    expect(res.headers["x-boi-card-reason"]).toBe("thin_corpus");
    // Still 1080x1920 — an honest page, not an error the user cannot read.
    expect(pngSize(res.rawPayload)).toEqual({ width: CARD_WIDTH, height: CARD_HEIGHT });
    writeFileSync(join(OUT, "thin.png"), res.rawPayload);
  });

  it("refuses when the denominator is too small to quote", () => {
    const d = digest("healthy");
    (d.whole_life as Record<string, unknown>)["relationships_ranked"] = 4;
    (d.whole_life as Record<string, unknown>)["relationships_gone_quiet"] = 1;
    const model = buildCardModel(d);
    // "25% of your 4 closest friendships" swings 25 points per person. It sounds
    // precise and is not.
    expect(model.kind).toBe("refusal");
    expect(model.kind === "refusal" && model.reason).toBe("not_enough_ranked");
  });

  it("refuses when the digest has fewer than two archetypes", () => {
    const d = digest("healthy");
    d.relationships = d.relationships.map((r) => ({ ...r, archetype: null }));
    const model = buildCardModel(d);
    expect(model.kind === "refusal" && model.reason).toBe("no_archetypes");
  });
});

describe("name overflow", () => {
  it("truncates a 40-character name and renders a 1-character name", async () => {
    const long = "Bartholomew Ferdinand Wickersham III"; // 36
    const forty = "A".repeat(40);

    expect(truncateName(forty).length).toBe(MAX_NAME_CHARS);
    expect(truncateName(forty).endsWith("…")).toBe(true);
    expect(truncateName("Z")).toBe("Z");
    expect(truncateName(long).length).toBeLessThanOrEqual(MAX_NAME_CHARS);

    const wide = digest("healthy");
    wide.relationships = wide.relationships.map((r) => ({ ...r, display: forty.slice(0, 40) }));
    const wideRes = await app.inject({ method: "POST", url: "/render", payload: wide });
    expect(wideRes.statusCode).toBe(200);
    expect(pngSize(wideRes.rawPayload)).toEqual({ width: CARD_WIDTH, height: CARD_HEIGHT });
    writeFileSync(join(OUT, "name-40-chars.png"), wideRes.rawPayload);

    const narrow = digest("healthy");
    narrow.relationships = narrow.relationships.map((r) => ({ ...r, display: "Z" }));
    const narrowRes = await app.inject({ method: "POST", url: "/render", payload: narrow });
    expect(narrowRes.statusCode).toBe(200);
    expect(pngSize(narrowRes.rawPayload)).toEqual({ width: CARD_WIDTH, height: CARD_HEIGHT });
    writeFileSync(join(OUT, "name-1-char.png"), narrowRes.rawPayload);

    // The truncated name is what reaches the SVG — nothing longer slips past.
    const model = buildCardModel(wide);
    if (model.kind === "card") {
      for (const a of model.archetypes) expect(a.display.length).toBeLessThanOrEqual(MAX_NAME_CHARS);
    }
  });

  it("never lets a name collide with its archetype label", () => {
    // MAX_NAME_CHARS alone is not enough: "the one you keep waiting" is 24 characters,
    // and an 18-character name beside it needs more than the row has. The first render
    // of a 40-character name drew the name straight through the label.
    for (const name of ["A".repeat(40), "Bartholomew Ferdinand Wickersham III", "Z", "Mom"]) {
      const d = digest("healthy");
      d.relationships = d.relationships.map((r) => ({ ...r, display: name }));
      const model = buildCardModel(d);
      if (model.kind !== "card") throw new Error("expected a card");

      for (const a of model.archetypes) {
        const labelWidth = estimateWidth(a.label, ROW_SIZE, 700);
        const budget = CONTENT_WIDTH - labelWidth - ROW_GAP;
        const shown = fitToWidth(a.display, ROW_SIZE, Math.max(budget, ROW_SIZE));
        const total = labelWidth + ROW_GAP + estimateWidth(shown, ROW_SIZE);
        expect(total, `${a.label} + ${shown} overflows the row`).toBeLessThanOrEqual(
          CONTENT_WIDTH + 1,
        );
      }
    }
  });

  it("keeps every wrapped line inside the margins", () => {
    const model = buildCardModel(digest("healthy"));
    if (model.kind !== "card") throw new Error("expected a card");
    // The caption used to run off the right edge: "…went quiet this yea".
    for (const line of wrapByWidth(model.caption, 46, CONTENT_WIDTH)) {
      expect(estimateWidth(line, 46)).toBeLessThanOrEqual(CONTENT_WIDTH);
    }
  });

  it("survives a display name made entirely of XML metacharacters", () => {
    const d = digest("healthy");
    d.relationships = d.relationships.map((r) => ({ ...r, display: `<&">'` }));
    const svg = cardSvg(buildCardModel(d));
    // Escaped, so the SVG still parses — and it still renders.
    expect(svg).toContain("&lt;&amp;&quot;&gt;&apos;");
    expect(() => renderCard(d)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("invitation, never verdict", () => {
  it("ships none of the metrics CONTRACTS.md forbids", () => {
    // The banned term is READ OUT OF the contract rather than written here.
    //
    // Two reasons. It keeps this test correct if § 6's list ever grows — and the
    // Definition of Done greps this directory for the term and expects no matches, so
    // spelling it in a test that asserts its ABSENCE would fail the criterion with a
    // false positive. Reading it from the contract keeps that grep a meaningful check
    // on this directory rather than a check on how the test is written.
    const contracts = readFileSync(
      join(process.cwd(), "prompts", "CONTRACTS.md"),
      "utf8",
    );
    const banned = [...contracts.matchAll(/\*\*Don't ship (\w+)\.\*\*/g)].map((m) =>
      m[1]!.toLowerCase(),
    );
    // If the parse ever stops finding anything this test would pass vacuously.
    expect(banned.length).toBeGreaterThan(0);

    // Stems, so a different inflection of the same metric is caught too.
    const stems = banned.map((w) => w.slice(0, 7));

    const sources = readdirSync(SRC)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => readFileSync(join(SRC, f), "utf8").toLowerCase());

    for (const stem of stems) {
      for (const s of allCopyStrings()) expect(s.toLowerCase()).not.toContain(stem);
      for (const src of sources) expect(src).not.toContain(stem);
    }
  });

  it("attaches no number to a person", () => {
    // A score next to a name is the thing Snapchat suppressed twice.
    const model = buildCardModel(digest("healthy"));
    if (model.kind !== "card") throw new Error("expected a card");
    for (const a of model.archetypes) {
      expect(a.display).not.toMatch(/\d/);
      expect(a.line).not.toMatch(/\d/);
      expect(a.label).not.toMatch(/\d/);
    }
  });

  it("never makes another person the subject of a verb", () => {
    // The mechanical half of the copy rule. "Sarah doesn't text you back" is a claim
    // about someone who never consented; "you've been the one reaching out" is a fact
    // about the user. Every line about a relationship is second person.
    for (const line of Object.values(ARCHETYPE_LINE)) {
      expect(line, line).toMatch(/\b(you|you're|you've|this)\b/i);
      // Third-person verbs that would make the other person the actor.
      expect(line, line).not.toMatch(/\b(they|she|he)\b/i);
      expect(line, line).not.toMatch(/\b(doesn't|didn't|won't|never replies|ignores)\b/i);
    }
  });

  it("keeps the archetype labels shapes, not accusations", () => {
    for (const label of Object.values(ARCHETYPE_LABEL)) {
      expect(label, label).not.toMatch(/\b(bad|worst|ignore|fail|dead|ghost)\b/i);
    }
  });
});
