// Analytics — PRD §47. Aggregates across member stores; no external store needed at P0.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog } from "./benefits.js";

export function computeAnalytics(membersDir) {
  const catalog = Object.fromEntries(loadCatalog().benefits.map((b) => [b.id, b]));
  const members = [];
  if (existsSync(membersDir)) {
    for (const f of readdirSync(membersDir).filter((f) => f.endsWith(".json"))) {
      try { members.push(JSON.parse(readFileSync(join(membersDir, f), "utf8"))); } catch { /* skip */ }
    }
  }
  const sum = (fn) => members.reduce((a, m) => a + fn(m), 0);
  const interactions = members.flatMap((m) => m.interactions || []);
  const byAction = (a) => interactions.filter((i) => i.action === a).length;
  const surfacedIds = new Set(interactions.filter((i) => i.action === "shown").map((i) => i.benefit_id));
  const savings = members.flatMap((m) => m.savings_events || []);
  const catCount = {};
  for (const e of savings) {
    const c = catalog[e.benefit_id]?.category || "other";
    catCount[c] = (catCount[c] || 0) + (e.amount_saved || 0);
  }
  const proactive = members.flatMap((m) => m.proactive_log || []);
  return {
    generated_at: new Date().toISOString(),
    adoption: {
      activated_members: members.length,
      conversations: sum((m) => (m.message_log || []).filter((x) => x.role === "member").length),
      repeat_members: members.filter((m) =>
        new Set((m.message_log || []).map((x) => (x.at || "").slice(0, 10))).size > 1).length,
    },
    discovery: {
      benefits_surfaced: byAction("shown"),
      unique_benefits_discovered: surfacedIds.size,
      catalog_size: Object.keys(catalog).length,
      top_categories: Object.entries(
        interactions.reduce((acc, i) => {
          const c = catalog[i.benefit_id]?.category;
          if (c) acc[c] = (acc[c] || 0) + 1;
          return acc;
        }, {})).sort((a, b) => b[1] - a[1]).slice(0, 5),
    },
    conversion: {
      saved: byAction("saved"),
      redeemed: byAction("redeemed"),
      dismissed: byAction("dismissed"),
    },
    member_value: {
      total_estimated_savings: Math.round(sum((m) => (m.savings_events || []).reduce((a, e) => a + (e.amount_saved || 0), 0)) * 100) / 100,
      savings_by_category: catCount,
      benefits_used: savings.length,
    },
    memory: {
      memories_total: sum((m) => (m.memories || []).filter((x) => x.active).length),
      confirmed: sum((m) => (m.memories || []).filter((x) => x.active && x.user_confirmed).length),
      deleted: sum((m) => (m.memories || []).filter((x) => !x.active).length),
      watches_active: sum((m) => (m.watches || []).filter((w) => w.active).length),
      trips: sum((m) => (m.trips || []).length),
    },
    proactive: {
      sent: proactive.length,
      by_kind: proactive.reduce((acc, p) => { acc[p.kind] = (acc[p.kind] || 0) + 1; return acc; }, {}),
    },
  };
}

/** Minimal HTML dashboard for GET /dashboard. */
export function dashboardHTML(a) {
  const row = (k, v) => `<tr><td>${k}</td><td><b>${v}</b></td></tr>`;
  const sec = (title, obj) => `<h2>${title}</h2><table>${Object.entries(obj)
    .map(([k, v]) => row(k.replaceAll("_", " "), typeof v === "object" ? `<code>${JSON.stringify(v)}</code>` : v)).join("")}</table>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AARP Concierge — Analytics</title>
<style>body{font:15px -apple-system,system-ui;margin:2rem auto;max-width:640px;padding:0 1rem;color:#222}
h1{font-size:1.3rem}h2{font-size:1rem;margin-top:1.5rem;color:#8b0000}
table{border-collapse:collapse;width:100%}td{padding:.3rem .5rem;border-bottom:1px solid #eee}
td:last-child{text-align:right}code{font-size:.8em}</style>
<h1>AARP Concierge — prototype analytics</h1>
<p style="color:#777">generated ${a.generated_at}</p>
${sec("Adoption", a.adoption)}${sec("Discovery", a.discovery)}${sec("Conversion", a.conversion)}
${sec("Member value", a.member_value)}${sec("Memory", a.memory)}${sec("Proactive", a.proactive)}`;
}
