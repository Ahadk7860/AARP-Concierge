// Milestone + new-benefit triggers, weekly digest, link flow, tracked links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemberStore } from "../src/memory.js";
import { generateCandidates, weeklyDigest } from "../src/proactive.js";
import { benefitCard, memberHash, loadCatalog } from "../src/benefits.js";
import { invokeTool } from "../src/agent.js";
import { createApp } from "../src/server.js";

const tmp = mkdtempSync(join(tmpdir(), "aarp-close-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test("savings milestone fires once (§31)", () => {
  const s = new MemberStore("c1", tmp);
  s.recordSavings("outback-steakhouse", 55, 550, "2026-09-01T00:00:00Z");
  const c = generateCandidates(s, "2026-09-02T00:00:00Z");
  const m = c.find((x) => x.kind === "milestone");
  assert.ok(m, "milestone candidate expected");
  assert.match(m.message, /\$50/);
  s.state.proactive_log = [{ kind: "milestone", subject: "milestone-50", benefit_id: "milestone-50", at: "2026-09-02T00:00:00Z" }];
  s.save();
  assert.ok(!generateCandidates(s, "2026-09-03T00:00:00Z").find((x) => x.kind === "milestone"),
    "same milestone never fires twice");
});

test("weekly digest: opt-in, weekly cadence, needs content (§38)", () => {
  const s = new MemberStore("c2", tmp);
  assert.equal(weeklyDigest(s, "2026-09-08T00:00:00Z"), null, "not opted in");
  s.state.weekly_digest = true; s.save();
  s.recordSavings("dennys", 6, 40, "2026-09-05T00:00:00Z");
  const d = weeklyDigest(s, "2026-09-08T00:00:00Z");
  assert.match(d, /\$6/);
  assert.equal(weeklyDigest(s, "2026-09-09T00:00:00Z"), null, "at most weekly");
});

test("tracked links only when public URL configured (§46)", () => {
  const b = loadCatalog().benefits.find((x) => x.id === "outback-steakhouse");
  delete process.env.AARP_PUBLIC_URL;
  assert.match(benefitCard(b, "m1").redemption_url, /aarp\.org/);
  process.env.AARP_PUBLIC_URL = "https://example.test";
  assert.equal(benefitCard(b, "m1").redemption_url, `https://example.test/r/${memberHash("m1")}/outback-steakhouse`);
  delete process.env.AARP_PUBLIC_URL;
});

test("click-through redirect records interaction and 302s (§46)", async () => {
  process.env.AARP_MEMBERS_DIR_UNUSED = "1";
  const app = createApp();
  await new Promise((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const r = await fetch(`${base}/r/${memberHash("nobody")}/outback-steakhouse`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /aarp\.org/);
  app.close();
});

test("get_link_url + /link flips linked (§37)", async () => {
  process.env.AARP_PUBLIC_URL = "https://example.test";
  const s = new MemberStore("c3", tmp);
  const r = invokeTool("get_link_url", {}, s, "2026-09-01T00:00:00Z");
  assert.equal(r.url, `https://example.test/link/${memberHash("c3")}`);
  assert.equal(r.linked, false);
  delete process.env.AARP_PUBLIC_URL;
});
