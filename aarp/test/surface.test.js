// Onboarding, analytics, refresh plumbing, catalog path override.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePhone, onboardingHTML, prettyLine } from "../src/onboarding.js";
import { computeAnalytics, dashboardHTML } from "../src/analytics.js";
import { MemberStore } from "../src/memory.js";
import { createApp } from "../src/server.js";

const tmp = mkdtempSync(join(tmpdir(), "aarp-surface-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test("phone normalization", () => {
  assert.equal(normalizePhone("(555) 123-4567"), "+15551234567");
  assert.equal(normalizePhone("1 555 123 4567"), "+15551234567");
  assert.equal(normalizePhone("+447700900123"), "+447700900123");
  assert.equal(normalizePhone("hello"), null);
});

test("onboarding page renders with and without a configured line", () => {
  delete process.env.SPECTRUM_LINE_E164;
  assert.match(onboardingHTML(), /line number pending/);
  process.env.SPECTRUM_LINE_E164 = "+15550100123";
  const html = onboardingHTML();
  assert.equal(prettyLine("+15550100123"), "(555) 010-0123");
  assert.match(html, /\(555\) 010-0123/, "displays a human-readable number");
  assert.match(html, /sms:\+15550100123/);
  assert.match(html, /not an official/i);
  delete process.env.SPECTRUM_LINE_E164;
});

test("analytics aggregates member stores (§47)", () => {
  const s = new MemberStore("a1", tmp);
  s.logMessage("member", "hi", "2026-08-30T01:00:00Z");
  s.logMessage("member", "dinner", "2026-08-31T01:00:00Z");
  s.remember({ kind: "profile", key: "destination_preference", value: "Hawaii", source: "explicit" });
  s.recordInteraction("outback-steakhouse", "shown");
  s.recordSavings("outback-steakhouse", 8.2, 82);
  const a = computeAnalytics(tmp);
  assert.equal(a.adoption.activated_members, 1);
  assert.equal(a.adoption.repeat_members, 1);
  assert.ok(a.discovery.benefits_surfaced >= 1);
  assert.equal(a.member_value.benefits_used, 1);
  assert.ok(a.memory.memories_total >= 1);
  assert.match(dashboardHTML(a), /Adoption/);
});

test("server serves onboarding, analytics, dashboard; onboard validates phone", async () => {
  process.env.AARP_PROVIDER = "fake";
  const app = createApp();
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const home = await fetch(base + "/").then((r) => r.text());
  assert.match(home, /AARP<\/span> Concierge/);
  const bad = await fetch(base + "/onboard", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "nope" }) }).then((r) => r.json());
  assert.equal(bad.ok, false);
  const good = await fetch(base + "/onboard", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "555-867-5309" }) }).then((r) => r.json());
  assert.equal(good.ok, true);
  assert.equal(good.registered, false, "no photon in tests — registration degrades gracefully");
  const an = await fetch(base + "/analytics").then((r) => r.json());
  assert.ok("adoption" in an);
  const dash = await fetch(base + "/dashboard").then((r) => r.text());
  assert.match(dash, /prototype analytics/);
  app.close();
});

test("catalog path override falls back to baked file on missing path", async () => {
  process.env.AARP_CATALOG_PATH = join(tmp, "nonexistent.json");
  const { invalidateCatalog, loadCatalog } = await import("../src/benefits.js");
  invalidateCatalog();
  const c = loadCatalog();
  assert.ok(c.benefits.length > 250);
  delete process.env.AARP_CATALOG_PATH;
  invalidateCatalog();
});
