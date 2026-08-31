// Builder MVP: config CRUD, draft/publish isolation, prompt rendering, API loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "aarp-builder-"));
process.env.AARP_CONFIG_PATH = join(tmp, "agent-config.json");
const cfg = await import("../src/agent-config.js");
const { createApp } = await import("../src/server.js");
test.after(() => { rmSync(tmp, { recursive: true, force: true }); delete process.env.AARP_CONFIG_PATH; });

test("draft edit does not touch published until publish (§27, §31, §42)", () => {
  cfg.updateDraftStep("food", "food-ask-cuisine", { question: "What sounds good tonight?" });
  const draft = cfg.getConfig("draft");
  const pub = cfg.getConfig("published");
  const q = (c) => c.flows.find((f) => f.id === "food").steps.find((s) => s.id === "food-ask-cuisine").question;
  assert.equal(q(draft), "What sounds good tonight?");
  assert.equal(q(pub), "What are you feeling tonight?", "published untouched by draft edit");
  assert.deepEqual(cfg.pendingChanges(), ["Food & Restaurants flow updated"]);
  const r = cfg.publish();
  assert.deepEqual(r.changes, ["Food & Restaurants flow updated"]);
  assert.equal(q(cfg.getConfig("published")), "What sounds good tonight?");
  assert.equal(cfg.pendingChanges().length, 0);
});

test("config renders into the prompt — the seam to live behavior (§43-44)", () => {
  cfg.updateDraftStep("gifts", "gifts-ask-details", { question: "What is Emma into right now?" });
  const draftPrompt = cfg.renderConfigPrompt(cfg.getConfig("draft"));
  const pubPrompt = cfg.renderConfigPrompt(cfg.getConfig("published"));
  assert.match(draftPrompt, /What is Emma into right now\?/);
  assert.doesNotMatch(pubPrompt, /What is Emma into right now\?/, "unpublished question stays out of live prompt");
  assert.match(pubPrompt, /food\.preferred_cuisine/, "memory field keys reach the prompt");
  assert.match(pubPrompt, /MEMORY SCHEMA/);
});

test("memory field editor updates draft schema", () => {
  const f = cfg.updateDraftMemoryField("food.preferred_cuisine", { ask: false, followup: "Fav food?" });
  assert.equal(f.ask, false);
  assert.equal(f.followup, "Fav food?");
  assert.ok(cfg.pendingChanges().includes("Memory schema updated"));
});

test("builder API: config, step edit, users, publish (§37 acceptance)", async () => {
  process.env.AARP_PROVIDER = "fake";
  const app = createApp();
  await new Promise((r) => app.listen(0, r));
  test.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const j = (u, o) => fetch(base + u, o).then((r) => r.json());

  const c = await j("/api/builder/config");
  assert.ok(c.draft.flows.length === 3);
  assert.ok(Array.isArray(c.pending_changes));

  const upd = await j("/api/builder/flows/food/steps/food-ask-cuisine", { method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "Hungry for anything in particular?" }) });
  assert.equal(upd.step.question, "Hungry for anything in particular?");

  const bad = await j("/api/builder/flows/nope/steps/x", { method: "PUT",
    headers: { "content-type": "application/json" }, body: "{}" });
  assert.ok(bad.error);

  const pub = await j("/api/builder/publish", { method: "POST" });
  assert.ok(pub.published_at);

  const ui = await fetch(base + "/builder").then((r) => r.text());
  assert.match(ui, /Agent Builder/);
  assert.match(ui, /Test Agent/);
  app.close();
});
