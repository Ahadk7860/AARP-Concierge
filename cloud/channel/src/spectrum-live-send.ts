// The live send. Prompt 10's last step, and the only place in this repo that texts a
// person.
//
// It sends EXACTLY the brief messages from the dry run that was reviewed — read out of
// `dry-run.json`, filtered to `brief-*`, in order. Not the onboarding pair (this account
// is already paired) and not the report (that is triggered by a user asking for it). What
// a human approved is what leaves.
import { readFileSync } from "node:fs";
import type { OutboundMessage } from "../../shared/src/index.js";
import { SpectrumChannel } from "./spectrum-channel.js";
import { LiveSpectrumPort, connectSpectrum } from "./spectrum-live.js";

const dryRunPath = process.argv[2];
const handle = process.argv[3];
if (!dryRunPath || !handle) throw new Error("usage: live-send <dry-run.json> <handle>");

const records = JSON.parse(readFileSync(dryRunPath, "utf8")) as Array<{ from: OutboundMessage }>;
const brief = records.map((r) => r.from).filter((m) => m.idempotency_key.startsWith("brief-"));
if (brief.length === 0) throw new Error("no brief messages in that dry run");

process.stdout.write(`sending ${brief.length} message(s) to ${handle}\n`);
for (const m of brief) {
  const kinds = m.blocks.map((b) => b.type).join(",");
  process.stdout.write(`  ${m.idempotency_key}  [${kinds}]\n`);
}

const { spaces, stop } = await connectSpectrum();
const spaceIds = new Map<string, string>();
const channel = new SpectrumChannel({
  port: new LiveSpectrumPort(spaces),
  spaceFor: async (userId) => ({ handle, spaceId: spaceIds.get(userId) ?? null }),
  rememberSpace: async (userId, id) => { spaceIds.set(userId, id); },
  log: (e) => process.stdout.write(`${JSON.stringify(e)}\n`),
});

try {
  for (const message of brief) {
    const result = await channel.send(message);
    process.stdout.write(`${JSON.stringify({
      msg: "live.sent",
      key: message.idempotency_key,
      message_id: result.message_id,
      protocol: result.protocol,
      line: result.line_id,
    })}\n`);
  }
  process.stdout.write(`\nhealth: ${JSON.stringify(await channel.health())}\n`);
} finally {
  await stop();
}
