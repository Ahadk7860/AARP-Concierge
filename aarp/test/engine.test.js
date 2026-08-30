// node --test aarp/test/ — offline tests for search, memory, and the fake-provider loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchBenefits, categoriesForIntent, benefitCard } from "../src/benefits.js";
import { MemberStore } from "../src/memory.js";
import { converse } from "../src/agent.js";

const tmp = mkdtempSync(join(tmpdir(), "aarp-test-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test("intent mapping: everyday words → categories (PRD §7)", () => {
  assert.ok(categoriesForIntent("going to dinner tonight").includes("restaurants"));
  assert.ok(categoriesForIntent("renting a car tomorrow").includes("travel-carrentals"));
  assert.ok(categoriesForIntent("need a hotel in Boston").includes("travel-hotels"));
  assert.ok(categoriesForIntent("taking the grandkids somewhere fun").includes("entertainment"));
});

test("brand query finds the benefit with outlinks", () => {
  const r = searchBenefits("going to outback tonight");
  assert.ok(r.length > 0);
  const top = benefitCard(r[0].benefit);
  assert.equal(top.id, "outback-steakhouse");
  assert.match(top.redemption_url, /^https:\/\/www\.aarp\.org\//);
  assert.ok(top.outlink_url);
});

test("preference boost: preferred brand ranks higher (PRD §30)", () => {
  const plain = searchBenefits("dinner tonight");
  const boosted = searchBenefits("dinner tonight", { preferredBrands: ["Outback"] });
  const rank = (list, id) => list.findIndex((r) => r.benefit.id === id);
  const p = rank(plain, "outback-steakhouse"), b = rank(boosted, "outback-steakhouse");
  assert.ok(b >= 0 && (p === -1 || b <= p), `boosted rank ${b} should be <= plain rank ${p}`);
  assert.equal(boosted[0].benefit.id, "outback-steakhouse");
});

test("no match → empty, never fabricated (PRD §28)", () => {
  const r = searchBenefits("qwzzyx flurble");
  assert.equal(r.length, 0);
});

test("memory: remember, reinforce, expire, forget (PRD §§10-12, 34)", () => {
  const s = new MemberStore("t1", tmp);
  s.remember({ kind: "profile", key: "destination_preference", value: "Hawaii", source: "explicit", now: "2026-02-01T00:00:00Z" });
  s.remember({ kind: "profile", key: "destination_preference", value: "hawaii", source: "inferred", now: "2026-03-01T00:00:00Z" });
  assert.equal(s.activeMemories().length, 1, "same value reinforces, not duplicates");
  assert.ok(s.activeMemories()[0].confidence > 0.9);
  s.remember({ kind: "episodic", key: "trip", value: "Miami next week", source: "explicit",
    expiresAt: "2026-03-15T00:00:00Z", now: "2026-03-01T00:00:00Z" });
  assert.equal(s.activeMemories("2026-03-10T00:00:00Z").length, 2);
  assert.equal(s.activeMemories("2026-04-01T00:00:00Z").length, 1, "episodic memory expires");
  assert.equal(s.forget("hawaii"), 1);
  assert.equal(s.activeMemories("2026-03-10T00:00:00Z").length, 1);
});

test("savings tracker accumulates (PRD §22)", () => {
  const s = new MemberStore("t2", tmp);
  s.recordSavings("outback-steakhouse", 8.2, 82, "2026-05-01T00:00:00Z");
  s.recordSavings("dennys", 6, 40, "2026-06-01T00:00:00Z");
  assert.equal(Math.round(s.totalSaved()), 14);
});

test("fake-provider conversation persists across simulated dates (PRD §49)", async () => {
  const opts = { provider: "fake", membersDir: tmp };
  const r1 = await converse("t3", "going to outback tonight", { ...opts, now: "2026-08-01T18:00:00Z" });
  assert.match(r1, /Outback/i);
  assert.match(r1, /aarp\.org/);
  const s = new MemberStore("t3", tmp);
  s.remember({ kind: "profile", key: "family", value: "grandkids love toys", source: "explicit", now: "2026-08-01T18:10:00Z" });
  const r2 = await converse("t3", "what do you remember about me?", { ...opts, now: "2026-11-20T18:00:00Z" });
  assert.match(r2, /toys/);
});
