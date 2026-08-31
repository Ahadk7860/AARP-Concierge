// The functional Agent Builder UI — Builder MVP PRD §§3-4, 8, 19, 23-28.
// Single-page vanilla JS on the builder API. Nav: Map · Flows · Memory · Test Agent.
export function builderHTML() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Builder — AARP Concierge</title>
<style>
:root{--ink:#16181d;--mut:#6b7280;--line:#e6e7ea;--bg:#f7f7f8;--card:#fff;--acc:#16181d;--live:#0a7d33;--draft:#8a6d00;--red:#8b0000}
*{box-sizing:border-box;margin:0}
body{font:14px/1.45 -apple-system,system-ui;background:var(--bg);color:var(--ink);display:flex;min-height:100vh}
aside{width:200px;background:var(--card);border-right:1px solid var(--line);padding:14px;flex-shrink:0;display:flex;flex-direction:column}
aside h1{font-size:14px;margin:4px 6px 16px;display:flex;gap:8px;align-items:center}
aside h1 span{background:var(--ink);color:#fff;border-radius:6px;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:12px}
.navsec{font-size:10px;letter-spacing:.08em;color:var(--mut);margin:12px 6px 4px;text-transform:uppercase}
.nav{display:block;width:100%;text-align:left;padding:7px 10px;border:0;background:none;border-radius:8px;font:inherit;cursor:pointer;color:var(--ink)}
.nav.on{background:var(--bg);font-weight:600}
main{flex:1;padding:0;display:flex;flex-direction:column;min-width:0}
header{display:flex;align-items:center;gap:12px;padding:12px 22px;border-bottom:1px solid var(--line);background:var(--card)}
header .t{font-weight:600}
header .grow{flex:1}
.chip{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--mut)}
.chip.pend{color:var(--draft);border-color:#e7d9a0;background:#fdf8e7}
button.primary{background:var(--ink);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
#view{padding:22px;overflow:auto;flex:1}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.card h3{font-size:13px;margin-bottom:8px}
.mut{color:var(--mut);font-size:12px}
.badge{font-size:10px;padding:1px 7px;border-radius:99px;font-weight:600}
.badge.live{background:#e7f6ec;color:var(--live)}
.badge.draft{background:#fdf8e7;color:var(--draft)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.node{cursor:pointer;transition:box-shadow .15s}
.node:hover{box-shadow:0 2px 10px rgba(0,0,0,.08)}
.step{display:flex;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;background:var(--card);align-items:flex-start}
.step .type{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:6px;margin-top:1px}
.type.ask{background:#eef2ff;color:#3b47c4}.type.understand{background:#f1f5f9;color:#475569}
.type.do{background:#ecfdf5;color:#047857}.type.remember{background:#fdf2f8;color:#be185d}
.step.editable{cursor:pointer}.step.editable:hover{border-color:#b9bcc4}
.field{margin-bottom:12px}
.field label{display:block;font-size:11px;font-weight:600;color:var(--mut);margin-bottom:4px}
.field input[type=text],.field textarea{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font:inherit}
.row{display:flex;gap:8px;align-items:center}
.split{display:grid;grid-template-columns:1fr 320px;gap:16px;height:100%}
#chat{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:12px;min-height:420px}
#msgs{flex:1;padding:14px;overflow:auto}
.bub{max-width:80%;padding:8px 12px;border-radius:14px;margin-bottom:8px;white-space:pre-wrap;word-break:break-word}
.bub.u{background:#0b84fe;color:#fff;margin-left:auto}
.bub.a{background:#e9e9eb}
#composer{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}
#composer input{flex:1;padding:9px 12px;border:1px solid var(--line);border-radius:10px;font:inherit}
.trace h4{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:12px 0 5px}
.trace .item{font-size:12px;padding:6px 8px;background:var(--bg);border-radius:8px;margin-bottom:5px;word-break:break-word}
.memline{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px;align-items:center}
dialog{border:0;border-radius:14px;padding:20px;max-width:440px;width:92%;box-shadow:0 10px 40px rgba(0,0,0,.25)}
dialog::backdrop{background:rgba(0,0,0,.3)}
.tree{display:flex;flex-direction:column;align-items:center;padding:10px 0}
.tcols{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;margin-top:18px}
.vline{width:1px;height:18px;background:var(--line)}
a{color:inherit}
</style></head><body>
<aside>
  <h1><span>◆</span> Agent Builder</h1>
  <div class="navsec">Build</div>
  <button class="nav on" data-v="map">Map</button>
  <button class="nav" data-v="flows">Flows</button>
  <button class="nav" data-v="memory">Memory</button>
  <div class="navsec">Test</div>
  <button class="nav" data-v="test">Test Agent</button>
  <div style="flex:1"></div>
  <div class="mut" style="padding:6px">AARP Concierge<br><a href="/builder/mockup" style="color:var(--mut)">design mockup ↗</a></div>
</aside>
<main>
  <header>
    <div class="t" id="crumb">Map</div>
    <div class="grow"></div>
    <span class="chip" id="pending">loading…</span>
    <button class="ghost" data-v="test" onclick="nav('test')">Test Agent</button>
    <button class="primary" onclick="openPublish()">Publish</button>
  </header>
  <div id="view"></div>
</main>
<dialog id="pubdlg">
  <h3 style="margin-bottom:10px">Publish changes?</h3>
  <div id="publist" class="mut" style="margin-bottom:16px"></div>
  <div class="row" style="justify-content:flex-end">
    <button class="ghost" onclick="pubdlg.close()">Cancel</button>
    <button class="primary" onclick="doPublish()">Publish</button>
  </div>
</dialog>
<script>
let CFG = null;
const $ = (s) => document.querySelector(s);
const api = (u, o) => fetch(u, o).then(r => r.json());
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

async function loadCfg() {
  const d = await api("/api/builder/config");
  CFG = d.draft;
  const n = d.pending_changes.length;
  $("#pending").textContent = n ? \`\${n} unpublished change\${n>1?"s":""}\` : "up to date";
  $("#pending").className = "chip" + (n ? " pend" : "");
  window.__pending = d.pending_changes;
}

function nav(v, arg) {
  document.querySelectorAll(".nav").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  ({map, flows, memory, test})[v](arg);
}
document.querySelectorAll(".nav").forEach(b => b.onclick = () => nav(b.dataset.v));

// ---------- MAP ----------
async function map() {
  $("#crumb").textContent = "Map";
  const flowNodes = CFG.flows.map(f => \`
    <div class="card node" onclick="nav('flows','\${f.id}')">
      <div class="row" style="justify-content:space-between"><b>\${esc(f.name)}</b>
      <span class="badge \${f.status==='live'?'live':'draft'}">\${f.status==='live'?'Live':'Draft'}</span></div>
      <div class="mut">\${esc(f.description)}</div><div class="mut" style="margin-top:6px">\${f.steps.length} steps</div>
    </div>\`).join("");
  const memNodes = CFG.memory_schema.map(g => \`
    <div class="card node" onclick="nav('memory')">
      <b>\${esc(g.group)}</b><div class="mut">\${g.fields.map(f=>esc(f.label)).join(" · ")}</div>
    </div>\`).join("");
  $("#view").innerHTML = \`
    <div class="tree">
      <div class="card" style="text-align:center;min-width:260px"><b>\${esc(CFG.agent.name)}</b>
        <div class="mut">\${esc(CFG.agent.description)}</div></div>
      <div class="vline"></div>
      <div class="mut">Flows — what the agent does · Memory — what it learns</div>
    </div>
    <h3 style="margin:8px 0">Flows</h3><div class="grid">\${flowNodes}</div>
    <h3 style="margin:16px 0 8px">Memory</h3><div class="grid">\${memNodes}</div>\`;
}

// ---------- FLOWS ----------
function flows(openId) {
  const f = CFG.flows.find(x => x.id === openId) || CFG.flows[0];
  $("#crumb").textContent = "Flows · " + f.name;
  const tabs = CFG.flows.map(x => \`<button class="ghost" \${x.id===f.id?'style="font-weight:700;border-color:#999"':''} onclick="nav('flows','\${x.id}')">\${esc(x.name)}</button>\`).join(" ");
  const steps = f.steps.map(st => \`
    <div class="step \${st.type==='ask'||st.instructions?'editable':''}" onclick="editStep('\${f.id}','\${st.id}')">
      <span class="type \${st.type}">\${st.type}</span>
      <div style="flex:1">
        <b>\${esc(st.label)}</b>
        \${st.question ? \`<div style="margin-top:3px">“\${esc(st.question)}”</div>\` : ""}
        \${st.options?.length ? \`<div class="mut">suggested: \${st.options.map(esc).join(" · ")}</div>\` : ""}
        \${st.ask_when ? \`<div class="mut">ask when: \${esc(st.ask_when)}</div>\` : ""}
        \${st.remember && st.memory_field ? \`<div class="mut">remembers → <code>\${esc(st.memory_field)}</code></div>\` : ""}
        \${st.instructions ? \`<div class="mut">\${esc(st.instructions)}</div>\` : ""}
        \${st.action ? \`<div class="mut">uses: \${esc(st.action)}</div>\` : ""}
      </div>
    </div>\`).join("");
  $("#view").innerHTML = \`
    <div class="row" style="margin-bottom:14px;flex-wrap:wrap">\${tabs}</div>
    <div class="card"><div class="mut">Trigger</div><div>\${esc(f.trigger_description)}</div></div>
    \${steps}
    <div id="editor"></div>\`;
}

function editStep(flowId, stepId) {
  const f = CFG.flows.find(x => x.id === flowId);
  const st = f.steps.find(x => x.id === stepId);
  const isAsk = st.type === "ask";
  $("#editor").innerHTML = \`
    <div class="card" style="border-color:#b9bcc4">
      <h3>Edit — \${esc(st.label)}</h3>
      \${isAsk ? \`
      <div class="field"><label>Question</label><input type="text" id="e_q" value="\${esc(st.question||"")}"></div>
      <div class="field"><label>Suggested answers (one per line)</label><textarea id="e_opts" rows="4">\${esc((st.options||[]).join("\\n"))}</textarea></div>
      <div class="field"><label>Ask this when</label><input type="text" id="e_when" value="\${esc(st.ask_when||"")}"></div>
      <div class="field row"><label style="margin:0">Remember their answer?</label>
        <input type="checkbox" id="e_rem" \${st.remember?"checked":""}>
        <input type="text" id="e_mem" value="\${esc(st.memory_field||"")}" placeholder="memory field e.g. food.preferred_cuisine" style="flex:1;padding:6px 8px;border:1px solid var(--line);border-radius:8px">
      </div>\` : \`
      <div class="field"><label>Instructions</label><textarea id="e_ins" rows="3">\${esc(st.instructions||"")}</textarea></div>\`}
      <div class="row" style="justify-content:flex-end">
        <button class="ghost" onclick="nav('flows','\${flowId}')">Cancel</button>
        <button class="primary" onclick="saveStep('\${flowId}','\${stepId}',\${isAsk})">Save</button>
      </div>
    </div>\`;
  $("#editor").scrollIntoView({behavior:"smooth"});
}

async function saveStep(flowId, stepId, isAsk) {
  const patch = isAsk ? {
    question: $("#e_q").value,
    options: $("#e_opts").value.split("\\n").map(s=>s.trim()).filter(Boolean),
    ask_when: $("#e_when").value,
    remember: $("#e_rem").checked,
    memory_field: $("#e_mem").value,
  } : { instructions: $("#e_ins").value };
  await api(\`/api/builder/flows/\${flowId}/steps/\${stepId}\`, { method:"PUT",
    headers:{"content-type":"application/json"}, body: JSON.stringify(patch) });
  await loadCfg(); nav("flows", flowId);
}

// ---------- MEMORY ----------
async function memory() {
  $("#crumb").textContent = "Memory";
  const schema = CFG.memory_schema.map(g => \`
    <div class="card"><h3>\${esc(g.group)}</h3>
      \${g.fields.map(fl => \`
        <div class="memline">
          <div><b>\${esc(fl.label)}</b> <code class="mut">\${esc(fl.key)}</code>
            <div class="mut">\${esc(fl.description)}</div>
            <div class="mut">learn: \${fl.learn?"on":"off"} · follow-ups: \${fl.ask?"on":"off"} · personalize: \${fl.personalize?"on":"off"}</div>
          </div>
          <button class="ghost" onclick="editMem('\${fl.key}')">Edit</button>
        </div>\`).join("")}
    </div>\`).join("");
  const u = await api("/api/builder/users");
  const users = u.users.sort((a,b)=>(b.last_active||"").localeCompare(a.last_active||"")).map(x => \`
    <div class="memline"><div><b>\${esc(x.id)}</b> <span class="mut">\${x.memories} memories</span></div>
      <button class="ghost" onclick="viewUser('\${encodeURIComponent(x.id)}')">View</button></div>\`).join("") || '<div class="mut">no users yet</div>';
  $("#view").innerHTML = \`<div class="split" style="grid-template-columns:1fr 1fr;align-items:start">
    <div><h3 style="margin-bottom:8px">Schema — what the agent may learn</h3>\${schema}<div id="memedit"></div></div>
    <div><h3 style="margin-bottom:8px">Users — what it actually remembers</h3><div class="card" id="userlist">\${users}</div><div id="userview"></div></div>
  </div>\`;
}

function editMem(key) {
  let fl; for (const g of CFG.memory_schema) { const f = g.fields.find(x=>x.key===key); if (f) fl = f; }
  $("#memedit").innerHTML = \`<div class="card" style="border-color:#b9bcc4">
    <h3>\${esc(fl.label)}</h3>
    <div class="field"><label>What should the agent remember?</label><textarea id="m_desc" rows="2">\${esc(fl.description)}</textarea></div>
    <div class="field row"><label style="margin:0">Learn automatically</label><input type="checkbox" id="m_learn" \${fl.learn?"checked":""}></div>
    <div class="field row"><label style="margin:0">Can ask follow-up</label><input type="checkbox" id="m_ask" \${fl.ask?"checked":""}></div>
    <div class="field"><label>Suggested follow-up</label><input type="text" id="m_fu" value="\${esc(fl.followup||"")}"></div>
    <div class="field row"><label style="margin:0">Use to personalize</label><input type="checkbox" id="m_p" \${fl.personalize?"checked":""}></div>
    <div class="row" style="justify-content:flex-end">
      <button class="ghost" onclick="nav('memory')">Cancel</button>
      <button class="primary" onclick="saveMem('\${key}')">Save</button></div>
  </div>\`;
}

async function saveMem(key) {
  await api("/api/builder/memory/"+key, { method:"PUT", headers:{"content-type":"application/json"},
    body: JSON.stringify({ description:$("#m_desc").value, learn:$("#m_learn").checked,
      ask:$("#m_ask").checked, followup:$("#m_fu").value, personalize:$("#m_p").checked }) });
  await loadCfg(); nav("memory");
}

async function viewUser(id) {
  const d = await api("/api/builder/users/"+id);
  $("#userview").innerHTML = \`<div class="card" style="border-color:#b9bcc4">
    <h3>\${esc(d.id)} <span class="mut">· saved $\${(d.total_saved||0).toFixed(0)}</span></h3>
    \${d.memories.map(m => \`
      <div class="memline"><div>\${esc(m.key)}: <b>\${esc(m.value)}</b>
        <span class="mut">(\${m.source}\${m.user_confirmed?", confirmed":""}, conf \${(m.confidence).toFixed(2)})</span></div>
        <button class="ghost" onclick="forget('\${id}','\${esc(String(m.value)).slice(0,40)}')">Forget</button>
      </div>\`).join("") || '<div class="mut">no memories yet</div>'}
    \${d.watches.length ? '<h4 class="mut" style="margin-top:8px">Watches</h4>'+d.watches.map(w=>'<div class="mut">'+esc(w.subject)+'</div>').join("") : ""}
  </div>\`;
}

async function forget(id, text) {
  await api(\`/api/builder/users/\${id}/forget\`, { method:"POST",
    headers:{"content-type":"application/json"}, body: JSON.stringify({ text }) });
  viewUser(id);
}

// ---------- TEST ----------
let testMember = "builder-test-" + Math.random().toString(36).slice(2,7);
function test() {
  $("#crumb").textContent = "Test Agent (draft config)";
  $("#view").innerHTML = \`<div class="split">
    <div id="chat">
      <div id="msgs"><div class="mut" style="padding:6px">Testing against the <b>draft</b> configuration as member <code>\${testMember}</code>. <button class="ghost" style="padding:3px 8px" onclick="resetTest()">new test user</button></div></div>
      <div id="composer"><input id="ti" placeholder="e.g. Need a present for Emma" onkeydown="if(event.key==='Enter')sendTest()">
      <button class="primary" onclick="sendTest()">Send</button></div>
    </div>
    <div class="trace card" id="trace"><div class="mut">The explanation panel — flow, memories used, memories created — fills in after each reply.</div></div>
  </div>\`;
}
function resetTest(){ testMember = "builder-test-" + Math.random().toString(36).slice(2,7); test(); }

async function sendTest() {
  const t = $("#ti").value.trim(); if (!t) return;
  $("#ti").value = "";
  $("#msgs").insertAdjacentHTML("beforeend", \`<div class="bub u">\${esc(t)}</div>\`);
  $("#msgs").insertAdjacentHTML("beforeend", \`<div class="bub a" id="pendbub">…</div>\`);
  $("#msgs").scrollTop = 1e9;
  const d = await api("/api/builder/test", { method:"POST",
    headers:{"content-type":"application/json"}, body: JSON.stringify({ member_id: testMember, text: t }) });
  $("#pendbub").outerHTML = \`<div class="bub a">\${esc(d.reply || d.error || "(no reply)")}</div>\`;
  $("#msgs").scrollTop = 1e9;
  if (!d.trace) return;
  $("#trace").innerHTML = \`
    <h4>Config</h4><div class="item">\${d.trace.config} (unpublished edits apply here)</div>
    <h4>Memories used</h4>\${(d.trace.memories_used||[]).map(m=>\`<div class="item">\${esc(m.replace(/^- /,""))}</div>\`).join("") || '<div class="item mut">none — new user</div>'}
    <h4>Tools called</h4>\${(d.trace.tool_calls||[]).map(c=>\`<div class="item"><b>\${esc(c.tool)}</b> \${esc(JSON.stringify(c.input).slice(0,120))}</div>\`).join("") || '<div class="item mut">none</div>'}
    <h4>Memories created</h4>\${(d.trace.memories_created||[]).map(m=>\`<div class="item">+ \${esc(m)}</div>\`).join("") || '<div class="item mut">none this turn</div>'}\`;
}

// ---------- PUBLISH ----------
function openPublish() {
  const p = window.__pending || [];
  $("#publist").innerHTML = p.length ? p.map(c=>"• "+esc(c)).join("<br>") : "No unpublished changes.";
  pubdlg.showModal();
}
async function doPublish() {
  await api("/api/builder/publish", { method:"POST" });
  pubdlg.close(); await loadCfg();
}

loadCfg().then(() => nav("map"));
</script></body></html>`;
}
