// The whole pipe through `SpectrumChannel`, stopping at the wire.
//
// Prompt 10's pre-send step 3: "everything up to `send`, then print the outbound blocks
// and stop." The point is not that it is safe — it is that the LAST thing anybody reads
// before a real phone rings should be the actual bytes, produced by the actual channel,
// through the actual block-to-part mapping.
//
// So this substitutes `SpectrumChannel` for `StubChannel` and injects a port that records
// instead of transmitting. Everything above the port is production code: the composer, the
// card, `deliverBrief`, the block mapping, the service-to-protocol mapping. The only thing
// that does not happen is the request.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { OutboundMessage } from "../../shared/src/index.js";
import { SpectrumChannel } from "../../channel/src/spectrum-channel.js";
import type {
  SpectrumPart,
  SpectrumPort,
  SpectrumSendResult,
  SpectrumSpaceRef,
} from "../../channel/src/spectrum-port.js";

export type DryRunRecord = {
  space: SpectrumSpaceRef;
  parts: SpectrumPart[];
  /** The `outbound.v1` document this came from, so both sides of the mapping are visible. */
  from: OutboundMessage;
};

/**
 * A port that goes as far as the request and stops.
 *
 * `service: "iMessage"` on the synthetic result rather than `"unknown"`: a dry run must
 * not exercise the null-protocol path by accident, because that path sets the
 * handle-mismatch flag and the run would leave the account marked as not-on-iMessage for
 * a send that never happened.
 */
export class DryRunPort implements SpectrumPort {
  readonly records: DryRunRecord[] = [];
  readonly registered: Array<{ user_id: string; handles: readonly string[] }> = [];
  private pending: OutboundMessage | null = null;

  constructor(private readonly line: string) {}

  /** Called by the channel wrapper below so a record can name the message it came from. */
  expect(message: OutboundMessage): void {
    this.pending = message;
  }

  async createSpace(handle: string): Promise<SpectrumSpaceRef> {
    // Mirrors what the probe observed on the shared tier: local, derived from the handle,
    // and `phone` is the literal string rather than a number.
    return { id: `any;-;${handle}`, phone: "shared" };
  }

  async getSpace(spaceId: string): Promise<SpectrumSpaceRef> {
    return { id: spaceId, phone: "shared" };
  }

  async send(space: SpectrumSpaceRef, parts: readonly SpectrumPart[]): Promise<SpectrumSendResult> {
    this.records.push({
      space,
      parts: [...parts],
      from: this.pending ?? ({} as OutboundMessage),
    });
    return {
      message_id: `dry_${this.records.length}`,
      service: "iMessage",
      phone: this.line,
    };
  }

  async registerUser(input: { user_id: string; handles: readonly string[] }): Promise<void> {
    this.registered.push({ user_id: input.user_id, handles: [...input.handles] });
  }
}

/**
 * `SpectrumChannel` over a `DryRunPort`, with the user's handle wired in.
 *
 * The channel is the real one. If the block mapping is wrong, if the card is attached with
 * the wrong mime type, if a contact card silently disappears — this is where it shows,
 * and it shows before anybody's phone rings.
 */
export function dryRunSpectrumChannel(input: {
  handle: string;
  line: string;
  log?: (event: Record<string, unknown>) => void;
}): { channel: SpectrumChannel; port: DryRunPort } {
  const port = new DryRunPort(input.line);
  const spaces = new Map<string, string>();
  const channel = new SpectrumChannel({
    port,
    spaceFor: async (userId) => ({
      handle: input.handle,
      spaceId: spaces.get(userId) ?? null,
    }),
    rememberSpace: async (userId, spaceId) => { spaces.set(userId, spaceId); },
    ...(input.log ? { log: input.log } : {}),
  });

  // Wrap `send` so each record names the `outbound.v1` it came from. The channel's own
  // signature has no place to carry that, and a dry run whose output cannot be traced back
  // to the message that produced it is a list of strings.
  const realSend = channel.send.bind(channel);
  channel.send = async (msg: OutboundMessage) => {
    port.expect(msg);
    return realSend(msg);
  };

  return { channel, port };
}

/** What a human reads before saying yes. */
export function dryRunReport(records: readonly DryRunRecord[]): string {
  const lines = ["# Dry run — what WOULD have been sent", ""];
  for (const [index, record] of records.entries()) {
    lines.push(`## ${index + 1}. ${record.from.idempotency_key ?? "(unkeyed)"}`);
    lines.push(`space \`${record.space.id}\` · line \`${record.space.phone}\``);
    lines.push("");
    for (const part of record.parts) {
      if (part.kind === "text") {
        lines.push(`> ${part.text.replace(/\n/g, "\n> ")}`);
      } else if (part.kind === "attachment") {
        lines.push(`> [attachment ${part.mimeType} — ${part.name}]\n> ${part.url}`);
      } else {
        lines.push("> [Boi's contact card — native]");
      }
      lines.push("");
    }
  }
  lines.push(`**${records.length} message(s). Nothing left this process.**`);
  return lines.join("\n");
}

export async function writeDryRunReport(
  artifactDir: string,
  records: readonly DryRunRecord[],
): Promise<string> {
  const report = dryRunReport(records);
  await writeFile(path.join(artifactDir, "dry-run.md"), `${report}\n`);
  await writeFile(path.join(artifactDir, "dry-run.json"), JSON.stringify(records, null, 2));
  return report;
}
