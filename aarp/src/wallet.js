// Purchasing onboarding — Stripe payment vault + saved addresses (PRD §§7-11, 31-32).
//
// Raw card data NEVER touches this server: with Stripe configured, the card is
// entered into Stripe's Payment Element on the /wallet page and confirmed against
// a SetupIntent; we store only {stripe ids, brand, last4}. Without Stripe keys the
// page offers a clearly-labeled simulated test card so the demo loop works.
import { randomUUID } from "node:crypto";
import { memberHash } from "./benefits.js";

const STRIPE_KEY = () => process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUB = () => process.env.STRIPE_PUBLISHABLE_KEY || "";

async function stripe(path, params = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_KEY()}`, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `stripe ${r.status}`);
  return d;
}
async function stripeGet(path) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    headers: { Authorization: `Bearer ${STRIPE_KEY()}` } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `stripe ${r.status}`);
  return d;
}

export const stripeConfigured = () => !!(STRIPE_KEY() && STRIPE_PUB());

export async function createSetupIntent(store) {
  if (!store.state.stripe_customer_id) {
    const c = await stripe("customers", { description: `AARP Concierge member ${memberHash(store.state.member_id)}` });
    store.state.stripe_customer_id = c.id; store.save();
  }
  const si = await stripe("setup_intents", { customer: store.state.stripe_customer_id, "payment_method_types[]": "card" });
  return { client_secret: si.client_secret, publishable_key: STRIPE_PUB() };
}

export async function confirmPaymentMethod(store, paymentMethodId) {
  const pm = await stripeGet("payment_methods/" + paymentMethodId);
  const rec = {
    id: "pm_" + randomUUID().slice(0, 8),
    stripe_payment_method_id: pm.id,
    brand: pm.card?.brand || "card", last4: pm.card?.last4 || "????",
    exp_month: pm.card?.exp_month, exp_year: pm.card?.exp_year,
    display: `${(pm.card?.brand || "Card").replace(/^./, (c) => c.toUpperCase())} •••• ${pm.card?.last4}`,
    is_default: !(store.state.payment_methods || []).length, test: false,
    created_at: new Date().toISOString(),
  };
  store.state.payment_methods = [...(store.state.payment_methods || []), rec];
  store.save();
  return rec;
}

export function addTestCard(store) {
  const rec = { id: "pm_" + randomUUID().slice(0, 8), stripe_payment_method_id: null,
    brand: "visa", last4: "4242", display: "Visa •••• 4242 (test)",
    is_default: !(store.state.payment_methods || []).length, test: true,
    created_at: new Date().toISOString() };
  store.state.payment_methods = [...(store.state.payment_methods || []), rec];
  store.save();
  return rec;
}

export function addAddress(store, a) {
  const rec = { id: "addr_" + randomUUID().slice(0, 8),
    label: a.label || a.recipient_name || "Home",
    recipient_name: a.recipient_name || a.label || "",
    line1: a.line1, line2: a.line2 || "", city: a.city, state: a.state,
    postal_code: a.postal_code, country: a.country || "US",
    is_default: a.is_default ?? !(store.state.addresses || []).length,
    created_at: new Date().toISOString() };
  if (rec.is_default) for (const x of store.state.addresses || []) x.is_default = false;
  store.state.addresses = [...(store.state.addresses || []), rec];
  store.save();
  return rec;
}

export function walletSummary(store) {
  return {
    configured: stripeConfigured(),
    payment_methods: (store.state.payment_methods || []).map((p) => ({ id: p.id, display: p.display, is_default: p.is_default })),
    addresses: (store.state.addresses || []).map((a) => ({ id: a.id, label: a.label, city: a.city, state: a.state, is_default: a.is_default })),
    ready: !!(store.state.payment_methods || []).length && !!(store.state.addresses || []).length,
  };
}

/** The three-screen onboarding page (§§8-10), served at /wallet/<memberHash>. */
export function walletHTML(hash, summary) {
  const stripeReady = stripeConfigured();
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AARP Concierge — Purchasing setup</title>
${stripeReady ? '<script src="https://js.stripe.com/v3/"></script>' : ""}
<style>
:root{--red:#8b0000;--ink:#1d1d1f}
body{font:16px -apple-system,system-ui;margin:0;color:var(--ink);background:#faf8f5}
.wrap{max-width:440px;margin:0 auto;padding:2rem 1.2rem 4rem}
h1{font-size:1.35rem}h1 span{color:var(--red)}
.card{background:#fff;border:1px solid #eee;border-radius:14px;padding:1.2rem;margin:1rem 0;box-shadow:0 1px 4px rgba(0,0,0,.05)}
input{font:inherit;width:100%;box-sizing:border-box;padding:.65rem .8rem;border:1px solid #ccc;border-radius:10px;margin-top:.5rem}
.row{display:flex;gap:.5rem}.row input{flex:1}
button{font:inherit;font-weight:600;width:100%;padding:.8rem;margin-top:.8rem;border:0;border-radius:10px;background:var(--red);color:#fff;cursor:pointer}
.muted{color:#777;font-size:.85rem}.ok{color:#0a7d33;font-weight:600}
.lock{background:#f4efe9;border-radius:10px;padding:.7rem .9rem;font-size:.9rem;margin-top:.8rem}
#pe{margin-top:.8rem}
</style>
<div class="wrap">
  <h1>🟥 <span>AARP</span> Concierge — purchasing</h1>
  <p>When you find something you want, the concierge can prepare and place the order —
  <b>after you explicitly approve the final purchase.</b></p>

  <div class="card">
    <b>1 · Payment method</b>
    <div id="pmlist">${summary.payment_methods.map((p) => `<div class="ok">✓ ${p.display}${p.is_default ? " (default)" : ""}</div>`).join("") || '<div class="muted">No card yet.</div>'}</div>
    ${stripeReady
      ? `<div id="pe"></div><button id="savecard">Save card</button>
         <p class="muted">Your full card details are securely handled by Stripe and are not stored by AARP Concierge.</p>`
      : `<button onclick="testCard()">Add test card (Visa •••• 4242)</button>
         <p class="muted">Stripe isn't configured on this deployment yet — this adds a clearly-labeled simulated card so you can try the flow. No real charges are possible.</p>`}
  </div>

  <div class="card">
    <b>2 · Shipping address</b>
    <div id="addrlist">${summary.addresses.map((a) => `<div class="ok">✓ ${a.label} — ${a.city}, ${a.state}${a.is_default ? " (default)" : ""}</div>`).join("") || '<div class="muted">No address yet.</div>'}</div>
    <input id="a_label" placeholder="Label (Home, Michael, Emma…)">
    <input id="a_name" placeholder="Recipient name">
    <input id="a_line1" placeholder="Street address">
    <div class="row"><input id="a_city" placeholder="City"><input id="a_state" placeholder="State" maxlength="2"></div>
    <input id="a_zip" placeholder="ZIP">
    <label class="muted" style="display:flex;gap:.5rem;margin-top:.6rem"><input type="checkbox" id="a_default" checked style="width:auto;margin:0">Use as default shipping address</label>
    <button onclick="saveAddr()">Save address</button>
  </div>

  <div class="card">
    <b>3 · Purchase approval</b>
    <div class="lock">🔒 <b>Always require purchase approval — ON</b> (cannot be disabled)<br>
    <span class="muted">The concierge will always show you the final order — exact item, total, card, and destination — and wait for you to reply <b>BUY</b> before placing any order.</span></div>
  </div>
  <p class="muted" id="done">${summary.ready ? "You're set — head back to iMessage and ask it to find something." : ""}</p>
  <p class="muted">Prototype demo — not an official AARP product.</p>
</div>
<script>
const HASH = ${JSON.stringify(hash)};
async function post(u, b) { return fetch(u, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json()); }
async function testCard(){ const d = await post('/api/wallet/'+HASH+'/test-card'); if (d.ok) location.reload(); }
async function saveAddr(){
  const g = id => document.getElementById(id).value.trim();
  const d = await post('/api/wallet/'+HASH+'/address', {label:g('a_label'),recipient_name:g('a_name'),line1:g('a_line1'),city:g('a_city'),state:g('a_state').toUpperCase(),postal_code:g('a_zip'),is_default:document.getElementById('a_default').checked});
  if (d.ok) location.reload(); else alert(d.error||'check the fields');
}
${stripeReady ? `
(async () => {
  const si = await post('/api/wallet/'+HASH+'/setup-intent');
  if (si.error) { document.getElementById('pe').textContent = si.error; return; }
  const st = Stripe(si.publishable_key);
  const elements = st.elements({ clientSecret: si.client_secret });
  const pe = elements.create('payment'); pe.mount('#pe');
  document.getElementById('savecard').onclick = async () => {
    const { setupIntent, error } = await st.confirmSetup({ elements, redirect: 'if_required' });
    if (error) return alert(error.message);
    const d = await post('/api/wallet/'+HASH+'/confirm', { payment_method: setupIntent.payment_method });
    if (d.ok) location.reload();
  };
})();` : ""}
</script>`;
}
