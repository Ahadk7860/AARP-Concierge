#!/usr/bin/env node
// Demo harness — simulates the iMessage conversation, including simulated dates
// (PRD §49: "the executive demo should deliberately span multiple simulated dates
// to prove persistence").
//
// One-shot:    node aarp/src/demo.js --member sam --date 2026-11-20 "going to outback tonight"
// Interactive: node aarp/src/demo.js --member sam
//   /date 2026-12-01   jump the simulated clock
//   /profile           dump what the concierge knows
//   /reset             wipe this member
import { converse } from "./agent.js";
import { evaluateProactive } from "./proactive.js";
import { MemberStore } from "./memory.js";
import { createInterface } from "node:readline/promises";
import { unlinkSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
function flag(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
}
const member = flag("member", "demo-member");
let simDate = flag("date", new Date().toISOString().slice(0, 10));
const provider = flag("provider", process.env.AARP_PROVIDER || "anthropic");
const oneShot = args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--"))).pop();

const nowISO = () => `${simDate}T18:00:00.000Z`;

async function turn(text) {
  try {
    const reply = await converse(member, text, { now: nowISO(), provider });
    console.log(`\n🟦 AARP  [${simDate}]\n${reply}\n`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}

if (args.includes("--proactive")) {
  const r = evaluateProactive(member, { now: nowISO() });
  if (r.sent) console.log(`\n🟦 AARP (proactive) [${simDate}]\n${r.message}\n`);
  else console.log(`(nothing sent — ${r.reason})`);
} else if (oneShot) {
  await turn(oneShot);
} else {
  console.log(`AARP Concierge demo — member=${member} provider=${provider} date=${simDate}`);
  console.log(`commands: /date YYYY-MM-DD, /profile, /reset, /quit\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = (await rl.question(`🟩 you [${simDate}] > `)).trim();
    if (!line) continue;
    if (line === "/quit") break;
    if (line.startsWith("/date ")) { simDate = line.slice(6).trim(); console.log(`⏩ simulated date is now ${simDate}\n`); continue; }
    if (line === "/profile") {
      const s = new MemberStore(member);
      console.log(JSON.stringify(s.profileSummary(nowISO()), null, 1) + "\n"); continue;
    }
    if (line === "/reset") {
      const s = new MemberStore(member);
      if (existsSync(s.path)) unlinkSync(s.path);
      console.log("wiped.\n"); continue;
    }
    await turn(line);
  }
  rl.close();
}
