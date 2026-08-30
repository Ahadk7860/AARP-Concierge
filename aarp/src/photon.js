// Photon (Spectrum) wiring — the real iMessage loop.
//
//   inbound iMessage → app.messages (SDK stream) → converse() → reply in-space
//
// Playbook rules honored here: inbound is at-least-once (dedupe by message id,
// bounded), one member's turns are serialized, and the agent NEVER initiates a
// new conversation — proactive sends go only to members who have texted first
// (their space id is persisted on their member record).
import { converse } from "./agent.js";
import { evaluateProactive } from "./proactive.js";
import { MemberStore } from "./memory.js";

const SWEEP_INTERVAL_MS = Number(process.env.AARP_SWEEP_INTERVAL_MS || 6 * 3600 * 1000);

const seenIds = new Set();
const queues = new Map();
function enqueue(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).then(fn, fn);
  queues.set(key, next);
  return next;
}

function textOf(message) {
  const c = message.content;
  if (!c) return "";
  if (typeof c === "string") return c;
  if (c.type === "text" && typeof c.text === "string") return c.text;
  return typeof c.text === "string" ? c.text : "";
}

/** A stable member id from the sender (iMessage address) or the space. */
function memberIdOf(message, space) {
  return message.sender?.id || space?.id || "unknown";
}

export async function startPhoton({ log = console.log } = {}) {
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  if (!projectId || !projectSecret) {
    log("photon: SPECTRUM_PROJECT_ID/SECRET not set — iMessage loop disabled (HTTP bridge only)");
    return null;
  }
  const { Spectrum, text } = await import("@spectrum-ts/core");
  const { imessage } = await import("@spectrum-ts/imessage");
  const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
  log("photon: connected");

  const liveSpaces = new Map(); // member_id → Space (seen this process)

  // ---- inbound loop ----
  (async () => {
    try {
      for await (const [space, message] of app.messages) {
        try {
          if (message.direction === "outbound" || message.sender?.kind === "agent") continue;
          const body = textOf(message).trim();
          if (!body) continue;
          if (seenIds.has(message.id)) continue;
          seenIds.add(message.id);
          if (seenIds.size > 2000) seenIds.delete(seenIds.values().next().value);

          const memberId = memberIdOf(message, space);
          liveSpaces.set(memberId, space);
          const store = new MemberStore(memberId);
          store.state.space_id = space.id;
          store.save();

          log(`photon: inbound from ${memberId}: ${body.slice(0, 80)}`);
          await enqueue(memberId, async () => {
            const reply = await app.responding(space, () => converse(memberId, body));
            await app.send(space, text(reply));
            log(`photon: replied to ${memberId} (${reply.length} chars)`);
          });
        } catch (e) {
          log(`photon: turn failed: ${e.message}`);
        }
      }
      log("photon: message stream ended");
    } catch (e) {
      log(`photon: stream error: ${e.message}`);
    }
  })();

  // ---- proactive sweep (§45): only members with a live space this process ----
  const sweep = setInterval(async () => {
    for (const [memberId, space] of liveSpaces) {
      try {
        const r = evaluateProactive(memberId);
        if (r.sent) {
          await app.send(space, text(r.message));
          log(`photon: proactive → ${memberId}: ${r.candidate.subject}`);
        }
      } catch (e) {
        log(`photon: sweep failed for ${memberId}: ${e.message}`);
      }
    }
  }, SWEEP_INTERVAL_MS);

  return { app, stop: async () => { clearInterval(sweep); await app.stop(); } };
}
