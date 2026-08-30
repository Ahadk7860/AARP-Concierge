// Tester onboarding for the shared Photon pool.
//
// On the shared Photon tier the line number is a PROJECT CONSTANT (space.phone
// reads back the literal "shared", so the number comes from config —
// SPECTRUM_LINE_E164, copied from the Photon dashboard). Onboarding therefore:
//   1. collects the tester's phone number,
//   2. registers/allowlists it with Photon (space.create — required on the
//      shared tier so outbound replies to them are legal),
//   3. hands back the line number + an sms: deep link with a prefilled first
//      message, plus things to try.
// The MEMBER always texts first — the agent never cold-opens (Photon caps new
// conversations, and it's the right product behavior anyway).

const TRY_PROMPTS = [
  "Going out to dinner tonight",
  "I'm going to Hawaii next month",
  "Taking the grandkids out this weekend",
  "What discounts do I have near me?",
  "Keep an eye out for hotel deals in Florida",
];

export function lineNumber() {
  const line = process.env.SPECTRUM_LINE_E164 || "";
  return /^\+[1-9][0-9]{6,14}$/.test(line) ? line : null;
}

/** Human-readable US line for display; the sms: link always uses E.164. */
export function prettyLine(line) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(line || "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : line || "";
}

export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

/** Register the tester's handle with Photon so replies to them are allowed. */
export async function registerTester(phone, photon) {
  if (!photon?.app) return { registered: false, reason: "photon not connected" };
  try {
    const { imessage } = await import("@spectrum-ts/imessage");
    await imessage(photon.app).space.create(phone);
    return { registered: true };
  } catch (e) {
    return { registered: false, reason: e.message };
  }
}

export function onboardingHTML() {
  const line = lineNumber();
  const first = encodeURIComponent("Hi! What can my AARP membership do for me?");
  const smsHref = line ? `sms:${line}${line ? `&body=${first}` : ""}` : "#";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AARP Concierge — try the prototype</title>
<style>
:root{--red:#8b0000;--ink:#1d1d1f}
body{font:16px -apple-system,system-ui;margin:0;color:var(--ink);background:#faf8f5}
.wrap{max-width:480px;margin:0 auto;padding:2rem 1.2rem 4rem}
h1{font-size:1.5rem;margin:.2rem 0}h1 span{color:var(--red)}
.card{background:#fff;border:1px solid #eee;border-radius:14px;padding:1.2rem;margin:1rem 0;box-shadow:0 1px 4px rgba(0,0,0,.05)}
input{font:inherit;width:100%;box-sizing:border-box;padding:.7rem .9rem;border:1px solid #ccc;border-radius:10px}
button,.btn{font:inherit;font-weight:600;display:inline-block;width:100%;box-sizing:border-box;text-align:center;
 padding:.8rem;margin-top:.7rem;border:0;border-radius:10px;background:var(--red);color:#fff;cursor:pointer;text-decoration:none}
.muted{color:#777;font-size:.85rem}
.try{padding:.55rem .8rem;background:#f4efe9;border-radius:10px;margin:.4rem 0;font-size:.95rem}
.num{font-size:1.4rem;font-weight:700;letter-spacing:.5px}
#done{display:none}
</style>
<div class="wrap">
  <h1>🟥 <span>AARP</span> Concierge <small class="muted">prototype</small></h1>
  <p>A personal benefits concierge in iMessage. Text it before you spend — dinner, travel,
  shopping — and it finds what your AARP membership can do, learns what you care about,
  and gets smarter every time.</p>

  <div class="card" id="step1">
    <b>1 · Register your number</b>
    <p class="muted">We're on a shared iMessage line during the pilot, so your number needs
    to be registered before the concierge can text you back.</p>
    <input id="phone" type="tel" placeholder="+1 (555) 123-4567" autocomplete="tel">
    <button onclick="register()">Register</button>
    <p class="muted" id="err" style="color:#a00"></p>
  </div>

  <div class="card" id="done">
    <b>2 · Text the concierge</b>
    <p>You're registered. Save this number as <b>AARP</b> and send your first message:</p>
    <p class="num">${line ? prettyLine(line) : "(line number pending)"}</p>
    ${line ? `<a class="btn" href="${smsHref}">Open iMessage →</a>` : `<p class="muted">The line number will appear here once configured.</p>`}
  </div>

  <div class="card">
    <b>Things to try</b>
    ${TRY_PROMPTS.map((p) => `<div class="try">“${p}”</div>`).join("")}
    <div class="try">…or just tell it what you're about to buy.</div>
    <p class="muted">It remembers. Come back tomorrow and ask
    “what do you remember about me?” or “anything good for me?”</p>
  </div>

  <p class="muted">Prototype demo built on public AARP benefit listings — not an official
  AARP product. Don't send passwords or payment details.</p>
</div>
<script>
async function register(){
  const err = document.getElementById('err');
  err.textContent = '';
  const phone = document.getElementById('phone').value;
  const r = await fetch('/onboard', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({phone})});
  const d = await r.json();
  if (d.ok) {
    document.getElementById('done').style.display = 'block';
    document.getElementById('done').scrollIntoView({behavior:'smooth'});
  } else {
    err.textContent = d.error || 'Registration failed — check the number.';
  }
}
</script>`;
}

export const tryPrompts = TRY_PROMPTS;
