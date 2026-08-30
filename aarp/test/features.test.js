// Rewards, local restaurants (mocked fetch), member controls, opportunities, bridge server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemberStore } from "../src/memory.js";
import { getRewards } from "../src/rewards.js";
import { searchLocalRestaurants } from "../src/local_restaurants.js";
import { invokeTool } from "../src/agent.js";
import { searchBenefits } from "../src/benefits.js";
import { evaluateProactive } from "../src/proactive.js";
import { createApp } from "../src/server.js";

const tmp = mkdtempSync(join(tmpdir(), "aarp-feat-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test("rewards: expiring window + preference-ranked options (§23-25)", () => {
  const s = new MemberStore("r1", tmp);
  s.remember({ kind: "profile", key: "rewards_preference", value: "gift card", source: "explicit", now: "2026-08-30T00:00:00Z" });
  const r = getRewards(s, "2026-08-30T00:00:00Z");
  assert.equal(r.points_balance, 18450);
  assert.equal(r.expiring_soon.length, 1, "2,300 pts expiring 2026-10-01 is inside 60d of 2026-08-30");
  assert.match(r.redemption_options[0].label, /gift card/i, "learned preference ranks first");
  const later = getRewards(s, "2026-11-01T00:00:00Z");
  assert.equal(later.expiring_soon.length, 0, "past expiry drops out");
});

test("local restaurants: token scrape + api replay via mocked fetch", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("memberoffers.aarp.org")) {
      return { ok: true, status: 200, text: async () => 'blah let token = "TOK123"; blah' };
    }
    return { ok: true, status: 200, json: async () => ({
      paging: { totalResults: 1 },
      results: [{ offer: { offerId: "9", id: 1, titleShort: "50% OFF", name: "x", savings: 8,
        isOfferInStore: true, redemptionMethods: ["instore"] },
        vendor: { vendorId: 7, name: "Kabana", locations: [{ addressLine1: "1025 University Ave", city: "Berkeley", stateName: "CA", postalCode: "94702" }] } }],
    }) };
  };
  const r = await searchLocalRestaurants({ zip: "94710", keyword: "curry", fetchImpl });
  assert.equal(r.total, 1);
  assert.equal(r.offers[0].brand, "Kabana");
  assert.match(r.offers[0].redemption_url, /memberoffers\.aarp\.org/);
  assert.ok(calls.some((u) => u.includes("kigo/offers") && u.includes("postalCode=94710") && u.includes("keyword=curry")));
  await assert.rejects(() => searchLocalRestaurants({ zip: "abc", fetchImpl }), /zip/);
});

test("mute_category suppresses search results and proactive sends (§34)", () => {
  const s = new MemberStore("m1", tmp);
  s.muteCategory("restaurants");
  const r = searchBenefits("going to outback tonight", s.rankingContext());
  assert.equal(r.length, 0, "muted category returns nothing");
  s.addWatch({ watch_type: "dining", subject: "steakhouse deals", now: "2026-09-01T00:00:00Z" });
  const p = evaluateProactive("m1", { now: "2026-09-10T00:00:00Z", membersDir: tmp });
  assert.equal(p.sent, false, "proactive respects mute");
});

test("get_opportunities surfaces unused categories tied to memories (§26-27)", () => {
  const s = new MemberStore("o1", tmp);
  s.remember({ kind: "profile", key: "destination_preference", value: "Hawaii every winter", source: "explicit", now: "2026-08-01T00:00:00Z" });
  const r = invokeTool("get_opportunities", {}, s, "2026-08-30T00:00:00Z");
  assert.ok(r.unused_opportunities.length > 0);
  assert.ok(r.unused_opportunities.every((o) => o.redemption_url));
  assert.match(r.unused_opportunities[0].because, /Hawaii/);
});

test("savings goal progress (§38)", () => {
  const s = new MemberStore("g1", tmp);
  invokeTool("set_savings_goal", { target: 500 }, s, "2026-08-30T00:00:00Z");
  s.recordSavings("outback-steakhouse", 8.2, 82, "2026-09-01T00:00:00Z");
  const r = invokeTool("get_savings", {}, s, "2026-09-02T00:00:00Z");
  assert.equal(r.goal.target, 500);
  assert.ok(Math.abs(r.goal.progress - 8.2) < 0.01);
});

test("bridge: dedupe returns the same reply, per-member turns serialize", async () => {
  process.env.AARP_PROVIDER = "fake";
  const app = createApp();
  await new Promise((r) => app.listen(0, r));
  const port = app.address().port;
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json());
  const b = { member_id: "bridge-test-x", text: "going to outback tonight", message_id: "msg-1", now: "2026-08-30T18:00:00Z" };
  const [r1, r2] = await Promise.all([post("/inbound", b), post("/inbound", b)]);
  assert.equal(r1.reply, r2.reply);
  assert.ok(r1.deduped || r2.deduped, "one of the two must be the deduped echo");
  const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(h.ok, true);
  app.close();
});
