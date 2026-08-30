import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemberStore } from "../src/memory.js";
import { evaluateProactive, generateCandidates } from "../src/proactive.js";

const tmp = mkdtempSync(join(tmpdir(), "aarp-pro-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test("no memory, no watches → nothing sent (§33)", () => {
  const r = evaluateProactive("p0", { now: "2026-08-30T12:00:00Z", membersDir: tmp });
  assert.equal(r.sent, false);
});

test("christmas moment fires on grandkids-toys memory in November (§17)", () => {
  const s = new MemberStore("p1", tmp);
  s.remember({ kind: "profile", key: "grandchildren_interests", value: "grandkids love toys and LEGO",
    source: "explicit", now: "2026-08-01T00:00:00Z" });
  const r = evaluateProactive("p1", { now: "2026-11-20T12:00:00Z", membersDir: tmp });
  assert.equal(r.sent, true, JSON.stringify(r));
  assert.match(r.message, /Christmas/i);
  assert.match(r.message, /toys/i);
  // …but not in August
  const s2 = new MemberStore("p2", tmp);
  s2.remember({ kind: "profile", key: "grandchildren_interests", value: "grandkids love toys",
    source: "explicit", now: "2026-08-01T00:00:00Z" });
  const r2 = evaluateProactive("p2", { now: "2026-08-15T12:00:00Z", membersDir: tmp });
  assert.equal(r2.sent, false);
});

test("watch generates a candidate and frequency cap holds (§15, §33)", () => {
  const s = new MemberStore("p3", tmp);
  s.addWatch({ watch_type: "travel", subject: "Hawaii hotel deals", now: "2026-09-01T00:00:00Z" });
  const r1 = evaluateProactive("p3", { now: "2026-09-10T12:00:00Z", membersDir: tmp });
  assert.equal(r1.sent, true, JSON.stringify(r1));
  assert.match(r1.message, /Hawaii/);
  const r2 = evaluateProactive("p3", { now: "2026-09-12T12:00:00Z", membersDir: tmp });
  assert.equal(r2.sent, false);
  assert.match(r2.reason, /frequency cap/);
});

test("candidates carry a real benefit with a link", () => {
  const s = new MemberStore("p4", tmp);
  s.addWatch({ watch_type: "travel", subject: "rental car deals", now: "2026-09-01T00:00:00Z" });
  const cands = generateCandidates(s, "2026-09-10T12:00:00Z");
  assert.ok(cands.length > 0);
  assert.match(cands[0].benefit.redemption_url, /^https:\/\/www\.aarp\.org\//);
});
