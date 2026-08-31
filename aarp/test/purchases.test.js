// Buy It For Me — §35 acceptance criteria, especially the authorization gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemberStore } from "../src/memory.js";
import { isExplicitApproval, blockedCategory, createProposal, pendingProposal,
  recordAuthorization, submitCheckout, proposalDisplay } from "../src/purchases.js";
import { addTestCard, addAddress, walletSummary } from "../src/wallet.js";
import { searchProducts } from "../src/products.js";
import { invokeTool } from "../src/agent.js";

const tmp = mkdtempSync(join(tmpdir(), "aarp-buy-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function readyStore(id) {
  const s = new MemberStore(id, tmp);
  addTestCard(s);
  addAddress(s, { label: "Emma", recipient_name: "Emma", line1: "1 Main St", city: "Berkeley", state: "CA", postal_code: "94710" });
  return s;
}

test("§4 what counts as permission — exact list", () => {
  for (const ok of ["BUY", "buy", "Buy!", "Place the order", "Confirm purchase", "yes, buy that for $38.37", "Yes buy it"])
    assert.equal(isExplicitApproval(ok), true, ok);
  for (const no of ["looks good", "nice", "that's the one", "maybe", "sounds good", "yes", "ok buy me time", "buy it later maybe"])
    assert.equal(isExplicitApproval(no), false, no);
});

test("submit without authorization → PURCHASE_NOT_AUTHORIZED (§21)", () => {
  const s = readyStore("b1");
  const p = createProposal(s, { merchant: "Fat Brain Toys", product_name: "Gymnastics activity play set", subtotal: 42, discount: 0 });
  const r = submitCheckout(s, p.id);
  assert.equal(r.error, "PURCHASE_NOT_AUTHORIZED");
  assert.equal((s.state.orders || []).length, 0);
});

test("full loop: propose → BUY → execute; savings + memory recorded (§35)", () => {
  const s = readyStore("b2");
  const p = createProposal(s, { merchant: "Things Remembered", product_name: "Personalized gymnastics gym bag",
    subtotal: 37, discount: 7.4, ship_to: "Emma" });
  assert.match(proposalDisplay(p), /Reply BUY to place this exact order/);
  assert.match(proposalDisplay(p), /Ship to: Emma/);
  assert.equal(recordAuthorization(s, "sounds good"), null, "small talk never authorizes");
  const auth = recordAuthorization(s, "BUY");
  assert.ok(auth && auth.proposal_id === p.id);
  const r = submitCheckout(s, p.id);
  assert.ok(r.order, JSON.stringify(r));
  assert.equal(r.order.status, "purchased");
  assert.ok(Math.abs(s.totalSaved() - 7.4) < 0.01, "AARP savings recorded");
  assert.ok(s.activeMemories().some((m) => m.key === "purchase"), "purchase remembered");
});

test("authorization is single-use (§5)", () => {
  const s = readyStore("b3");
  const p = createProposal(s, { merchant: "Target", product_name: "LEGO building set", subtotal: 45 });
  recordAuthorization(s, "BUY");
  assert.ok(submitCheckout(s, p.id).order);
  const again = submitCheckout(s, p.id);
  assert.equal(again.error, "PURCHASE_NOT_AUTHORIZED", "used authorization cannot execute twice");
});

test("a new proposal invalidates the old one — price/item change (§6)", () => {
  const s = readyStore("b4");
  const p1 = createProposal(s, { merchant: "Target", product_name: "Fleece throw blanket", subtotal: 32 });
  const p2 = createProposal(s, { merchant: "Target", product_name: "Fleece throw blanket", subtotal: 39 });
  assert.equal((s.state.purchase_proposals || []).find((x) => x.id === p1.id).status, "cancelled");
  const auth = recordAuthorization(s, "BUY");
  assert.equal(auth.proposal_id, p2.id, "BUY binds to the current proposal only");
  assert.equal(submitCheckout(s, p1.id).error, "PURCHASE_NOT_AUTHORIZED", "old proposal cannot execute");
  assert.ok(submitCheckout(s, p2.id).order);
});

test("expired proposal cannot execute (§5)", () => {
  const s = readyStore("b5");
  const p = createProposal(s, { merchant: "Target", product_name: "Wireless earbuds", subtotal: 49 }, "2026-01-01T00:00:00Z");
  assert.equal(pendingProposal(s, "2026-01-01T00:10:00Z")?.id, p.id);
  assert.equal(pendingProposal(s, "2026-01-01T01:00:00Z"), null, "expired after 30 min");
  recordAuthorization(s, "BUY", "2026-01-01T00:10:00Z");
  const r = submitCheckout(s, p.id, "2026-01-01T01:00:00Z");
  assert.equal(r.error, "PROPOSAL_EXPIRED");
});

test("§28 blocked categories refuse at proposal AND product search", async () => {
  const s = readyStore("b6");
  assert.throws(() => createProposal(s, { merchant: "Laithwaites", product_name: "Cabernet gift set", subtotal: 44 }), /BLOCKED_CATEGORY/);
  assert.equal(blockedCategory("gift card $50"), "gift cards / cash equivalents");
  const r = invokeTool("search_products", { query: "red wine for Michael" }, s, new Date().toISOString());
  assert.match(r.error, /alcohol/);
});

test("no wallet → proposal refuses with setup guidance (§8)", () => {
  const s = new MemberStore("b7", tmp);
  assert.throws(() => createProposal(s, { merchant: "Target", product_name: "LEGO set", subtotal: 45 }), /NO_PAYMENT_METHOD/);
  addTestCard(s);
  assert.throws(() => createProposal(s, { merchant: "Target", product_name: "LEGO set", subtotal: 45 }), /NO_ADDRESS/);
  assert.equal(walletSummary(s).ready, false);
});

test("product discovery returns eligible retail goods with budget respect (§12, §28)", async () => {
  const r = await searchProducts({ query: "gift for granddaughter gymnastics crafts", budget: 50 });
  assert.ok(r.products.length >= 2);
  assert.ok(r.products.every((p) => p.price <= 65));
  assert.match(r.products[0].name, /gym/i);
});
