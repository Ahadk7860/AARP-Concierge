// HTTP surface: onboarding, analytics, click-through tracking, and a JSON bridge
// for driving the concierge without iMessage (demos, smoke tests).
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
import { getState, getConfig, updateDraftStep, updateDraftMemoryField, pendingChanges, publish } from "./agent-config.js";
import { walletHTML, walletSummary, createSetupIntent, confirmPaymentMethod, addTestCard, addAddress, stripeConfigured } from "./wallet.js";
import { builderHTML } from "./builder-ui.js";
import { refreshCatalog } from "./refresh.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

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

      // Agent Builder — the functional control plane (Builder MVP PRD).
      if (req.method === "GET" && (req.url === "/builder" || req.url === "/builder/")) {
        return html(builderHTML());
      }
      // The original static design mockup, kept for reference.
      if (req.method === "GET" && req.url === "/builder/mockup") {
        const p = join(HERE, "..", "builder", "index.html");
        if (existsSync(p)) return html(readFileSync(p, "utf8"));
        return send(404, { error: "builder bundle not found" });
      }

      // ---- Builder API ----
      if (req.url === "/api/builder/config" && req.method === "GET") {
        const st = getState();
        const cat = loadCatalog();
        return send(200, { draft: st.draft, published_at: st.published_at,
          draft_updated_at: st.draft_updated_at, pending_changes: pendingChanges(),
          knowledge: { benefits_total: cat.counts?.total ?? cat.benefits.length,
            refreshed: (cat.generated_at || "").slice(0, 10) } });
      }
      if (req.url?.match(/^\/api\/builder\/flows\/[\w-]+\/steps\/[\w-]+$/) && req.method === "PUT") {
        const parts = req.url.split("/");           // ["", "api", "builder", "flows", <flow>, "steps", <step>]
        const flowId = parts[4], stepId = parts[6];
        const patch = await readBody(req);
        try { return send(200, { step: updateDraftStep(flowId, stepId, patch) }); }
        catch (e) { return send(400, { error: e.message }); }
      }
      if (req.url?.match(/^\/api\/builder\/memory\/[\w.]+$/) && req.method === "PUT") {
        const key = req.url.split("/").pop();
        const patch = await readBody(req);
        try { return send(200, { field: updateDraftMemoryField(key, patch) }); }
        catch (e) { return send(400, { error: e.message }); }
      }
      if (req.url === "/api/builder/publish" && req.method === "POST") {
        return send(200, publish());
      }
      if (req.url === "/api/builder/users" && req.method === "GET") {
        mkdirSync(MEMBERS_DIR, { recursive: true });
        const users = readdirSync(MEMBERS_DIR).filter((f) => f.endsWith(".json")).map((f) => {
          const id = f.replace(/\.json$/, "");
          const st = new MemberStore(id, MEMBERS_DIR);
          return { id, memories: st.activeMemories().length,
            last_active: st.state.message_log.at(-1)?.at || null };
        });
        return send(200, { users });
      }
      if (req.url?.match(/^\/api\/builder\/users\/[^/]+$/) && req.method === "GET") {
        const id = decodeURIComponent(req.url.split("/").pop());
        const st = new MemberStore(id, MEMBERS_DIR);
        return send(200, { id, memories: st.activeMemories(),
          saved_benefits: st.state.saved_benefits, watches: st.state.watches.filter((w) => w.active),
          trips: st.state.trips.filter((t) => t.active), total_saved: st.totalSaved() });
      }
      if (req.url?.match(/^\/api\/builder\/users\/[^/]+\/memory$/) && req.method === "POST") {
        const id = decodeURIComponent(req.url.split("/")[4]);
        const { key, value, replace } = await readBody(req);
        if (!key || !value) return send(400, { error: "key and value required" });
        const st = new MemberStore(id, MEMBERS_DIR);
        if (replace) st.forget(String(replace));
        st.remember({ kind: "profile", key, value, source: "explicit", confidence: 1 });
        return send(200, { ok: true });
      }
      if (req.url?.match(/^\/api\/builder\/users\/[^/]+\/forget$/) && req.method === "POST") {
        const id = decodeURIComponent(req.url.split("/")[4]);
        const { text } = await readBody(req);
        const st = new MemberStore(id, MEMBERS_DIR);
        return send(200, { forgotten: st.forget(text) });
      }
      if (req.url === "/api/builder/test" && req.method === "POST") {
        const { member_id, text } = await readBody(req);
        if (!text) return send(400, { error: "text required" });
        const mid = member_id || "builder-test-user";
        const result = await enqueue(mid, () =>
          converse(mid, text, { useDraft: true, withTrace: true }));
        return send(200, result);
      }
      if (req.method === "GET" && req.url === "/analytics") return send(200, computeAnalytics(MEMBERS_DIR));
      if (req.method === "GET" && req.url === "/dashboard") return html(dashboardHTML(computeAnalytics(MEMBERS_DIR)));

      // §46: click-tracked redemption redirect — /r/<memberHash>/<benefitId>
      const rMatch = req.method === "GET" && req.url?.match(/^\/r\/([0-9a-f]{12})\/(.+)$/);
      if (rMatch) {
        const [, hash] = rMatch;
        // Ids carry uppercase (…-Q12026) and, historically, "&" — decode and match the
        // catalog rather than constraining the charset, which silently 404'd 9% of links.
        let benefitId = rMatch[2];
        try { benefitId = decodeURIComponent(benefitId); } catch { /* use raw */ }
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

      // §37 (mock): "linked member" flow — the agent hands out /link/<memberHash>;
      // opening it flips the member to linked mode (real AARP OAuth at pilot).
      const lMatch = req.method === "GET" && req.url?.match(/^\/link\/([0-9a-f]{12})$/);
      if (lMatch) {
        let linked = false;
        try {
          mkdirSync(MEMBERS_DIR, { recursive: true });
          for (const f of readdirSync(MEMBERS_DIR).filter((f) => f.endsWith(".json"))) {
            const id = f.replace(/\.json$/, "");
            if (memberHash(id) === lMatch[1]) {
              const st = new MemberStore(id, MEMBERS_DIR);
              st.state.linked = true; st.save(); linked = true; break;
            }
          }
        } catch { /* fall through to the page either way */ }
        return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font:17px -apple-system,system-ui;max-width:420px;margin:3rem auto;padding:0 1rem;text-align:center">
<h2 style="color:#8b0000">AARP account ${linked ? "linked ✓" : "link"}</h2>
<p>${linked ? "You're set — head back to iMessage. Your Rewards and saved benefits are now personalized." : "We couldn't match this link to a conversation. Text the concierge first, then tap the link it sends you."}</p>
<p style="color:#777;font-size:.85em">Prototype — demo linking only; no AARP credentials involved.</p></body>`);
      }

      // ---- Buy It For Me: wallet onboarding (PRD §§8-11) ----
      const wPage = req.method === "GET" && req.url?.match(/^\/wallet\/([0-9a-f]{12})$/);
      const wApi = req.url?.match(/^\/api\/wallet\/([0-9a-f]{12})\/(setup-intent|confirm|test-card|address)$/);
      const memberByHash = (hash) => {
        mkdirSync(MEMBERS_DIR, { recursive: true });
        for (const f of readdirSync(MEMBERS_DIR).filter((f) => f.endsWith(".json"))) {
          const id = f.replace(/\.json$/, "");
          if (memberHash(id) === hash) return new MemberStore(id, MEMBERS_DIR);
        }
        return null;
      };
      if (wPage) {
        const st = memberByHash(wPage[1]);
        if (!st) return html(`<!doctype html><meta charset="utf-8"><body style="font:17px -apple-system,system-ui;max-width:420px;margin:3rem auto;text-align:center"><h2 style="color:#8b0000">Link not recognized</h2><p>Text the concierge first, then tap the wallet link it sends you.</p></body>`);
        return html(walletHTML(wPage[1], walletSummary(st)));
      }
      if (wApi && req.method === "POST") {
        const st = memberByHash(wApi[1]);
        if (!st) return send(404, { error: "unknown member" });
        try {
          if (wApi[2] === "setup-intent") {
            if (!stripeConfigured()) return send(400, { error: "Stripe not configured" });
            return send(200, await createSetupIntent(st));
          }
          if (wApi[2] === "confirm") {
            const { payment_method } = await readBody(req);
            return send(200, { ok: true, method: await confirmPaymentMethod(st, payment_method) });
          }
          if (wApi[2] === "test-card") {
            if (stripeConfigured()) return send(400, { error: "Stripe is configured — add a real card via the form" });
            return send(200, { ok: true, method: addTestCard(st) });
          }
          if (wApi[2] === "address") {
            const a = await readBody(req);
            if (!a.line1 || !a.city || !a.state || !a.postal_code) return send(400, { ok: false, error: "street, city, state and ZIP are required" });
            return send(200, { ok: true, address: addAddress(st, a) });
          }
        } catch (e) { return send(500, { error: e.message }); }
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
  mkdirSync(MEMBERS_DIR, { recursive: true });
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
