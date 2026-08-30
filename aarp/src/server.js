// The Photon seam — an HTTP bridge between the iMessage provider webhook and the
// concierge. Zero-dep node http. Wire cloud/channel's webhook here when the AARP
// line's Photon credentials exist (see IMESSAGE_AGENT_PLAYBOOK.md §2).
//
//   POST /inbound  {member_id, text, message_id?, now?}   → {reply}
//   POST /sweep    {now?}                                 → proactive results, all members
//   GET  /health
//
// Playbook lessons honored: inbound is at-least-once → message_id dedupe returns the
// SAME reply for a duplicate; per-member turns are serialized so two texts arriving
// together can't interleave memory writes.
import { createServer } from "node:http";
import { readdirSync, mkdirSync } from "node:fs";
import { converse } from "./agent.js";
import { evaluateProactive } from "./proactive.js";
import { MemberStore } from "./memory.js";
import { computeAnalytics, dashboardHTML } from "./analytics.js";
import { loadCatalog, memberHash } from "./benefits.js";
import { onboardingHTML, normalizePhone, registerTester, lineNumber } from "./onboarding.js";
import { refreshCatalog } from "./refresh.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEMBERS_DIR = process.env.AARP_MEMBERS_DIR || join(HERE, "..", "data", "members");
const PORT = Number(process.env.PORT || process.env.AARP_PORT || 3055);

const seen = new Map();           // message_id → reply (canonical outcome for dupes)
const queues = new Map();         // member_id → promise chain

function enqueue(memberId, fn) {
  const prev = queues.get(memberId) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(memberId, next);
  return next;
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export function createApp({ photonRef = { current: null } } = {}) {
  return createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    try {
      if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, line: lineNumber(), photon: !!photonRef.current });
      if (req.method === "GET" && (req.url === "/" || req.url === "/onboard")) return html(onboardingHTML());
      if (req.method === "GET" && req.url === "/analytics") return send(200, computeAnalytics(MEMBERS_DIR));
      if (req.method === "GET" && req.url === "/dashboard") return html(dashboardHTML(computeAnalytics(MEMBERS_DIR)));

      // §46: click-tracked redemption redirect — /r/<memberHash>/<benefitId>
      const rMatch = req.method === "GET" && req.url?.match(/^\/r\/([0-9a-f]{12})\/([a-z0-9-]+)$/);
      if (rMatch) {
        const [, hash, benefitId] = rMatch;
        const benefit = loadCatalog().benefits.find((b) => b.id === benefitId);
        if (!benefit) return send(404, { error: "unknown benefit" });
        try {
          mkdirSync(MEMBERS_DIR, { recursive: true });
          for (const f of readdirSync(MEMBERS_DIR).filter((f) => f.endsWith(".json"))) {
            const id = f.replace(/\.json$/, "");
            if (memberHash(id) === hash) { new MemberStore(id, MEMBERS_DIR).recordInteraction(benefitId, "clicked"); break; }
          }
        } catch { /* click logging is best-effort; the redirect must still happen */ }
        res.writeHead(302, { location: benefit.redemption_url });
        return res.end();
      }

      if (req.method === "POST" && req.url === "/onboard") {
        const { phone } = await readBody(req);
        const e164 = normalizePhone(phone);
        if (!e164) return send(400, { ok: false, error: "That doesn't look like a phone number." });
        const reg = await registerTester(e164, photonRef.current);
        // A registration failure on the shared tier is worth surfacing but not fatal —
        // the tester can still text first, which registers the space implicitly.
        return send(200, { ok: true, line: lineNumber(), registered: reg.registered, note: reg.reason });
      }

      if (req.method === "POST" && req.url === "/inbound") {
        const { member_id, text, message_id, now } = await readBody(req);
        if (!member_id || !text) return send(400, { error: "member_id and text required" });
        if (message_id && seen.has(message_id)) return send(200, { reply: seen.get(message_id), deduped: true });
        const reply = await enqueue(member_id, () =>
          converse(member_id, text, now ? { now } : {}));
        if (message_id) {
          seen.set(message_id, reply);
          if (seen.size > 500) seen.delete(seen.keys().next().value);
        }
        return send(200, { reply });
      }

      if (req.method === "POST" && req.url === "/sweep") {
        mkdirSync(MEMBERS_DIR, { recursive: true });
        const { now } = await readBody(req);
        const results = {};
        for (const f of readdirSync(MEMBERS_DIR).filter((f) => f.endsWith(".json"))) {
          const id = f.replace(/\.json$/, "");
          results[id] = evaluateProactive(id, now ? { now } : {});
        }
        return send(200, { results });
      }

      send(404, { error: "not found" });
    } catch (e) {
      send(500, { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const photonRef = { current: null };
  createApp({ photonRef }).listen(PORT, () => console.log(`AARP concierge bridge on :${PORT}`));
  import("./photon.js").then(({ startPhoton }) =>
    startPhoton().then((p) => { photonRef.current = p; }).catch(
      (e) => console.log(`photon: failed to start: ${e.message}`)));
  // Daily benefit refresh (PRD §6) — jittered start so a fleet doesn't stampede AARP.
  const day = 24 * 3600 * 1000;
  setTimeout(() => {
    refreshCatalog().catch((e) => console.log(`refresh: failed: ${e.message}`));
    setInterval(() => refreshCatalog().catch((e) => console.log(`refresh: failed: ${e.message}`)), day);
  }, 60_000 + Math.floor(Math.random() * 600_000));
}
