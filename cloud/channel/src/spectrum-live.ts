// The real `SpectrumPort`, over Photon's SDK.
//
// Everything above this file has been exercised against a recorded transcript or a
// recording port since prompt 10 began. This is the twenty lines where that stops being
// true, and it is deliberately the smallest surface in the track: four methods, no
// branching on message content, no retries of its own.

import { Spectrum, attachment, text, type Space } from "@spectrum-ts/core";
import { imessage, nativeContactCard } from "@spectrum-ts/imessage";

import type {
  SpectrumPart,
  SpectrumPort,
  SpectrumSendResult,
  SpectrumService,
  SpectrumSpaceRef,
} from "./spectrum-port.js";

/**
 * The two space operations, structurally.
 *
 * Named as a pair rather than as the SDK's `PlatformInstance<IMessageDefinition>` because
 * that type is not exported — and writing `as` at this boundary is how a channel starts
 * lying about what it received. `Space` IS exported and carries `id` and `send`, which is
 * everything used here.
 */
type SpaceOps = {
  create(handle: string): Promise<Space>;
  get(id: string): Promise<Space>;
};

/**
 * Connect. Credentials come from the PROCESS ENVIRONMENT, never from a file read here.
 *
 * `.env` is loaded by `vite-node` and not by `vitest`, so a module that read the file
 * itself would behave differently depending on which runner started it — which is exactly
 * how the card signing key ended up disagreeing between a parent and its own child.
 */
export async function connectSpectrum(): Promise<{ spaces: SpaceOps; stop: () => Promise<void> }> {
  const projectId = process.env["SPECTRUM_PROJECT_ID"];
  const projectSecret = process.env["SPECTRUM_PROJECT_SECRET"];
  if (!projectId || !projectSecret) {
    throw new Error("SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET are not in the environment");
  }
  const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
  return { spaces: imessage(app).space, stop: () => app.stop() };
}

export class LiveSpectrumPort implements SpectrumPort {
  constructor(private readonly spaces: SpaceOps) {}

  async createSpace(handle: string): Promise<SpectrumSpaceRef> {
    // Observed on the shared tier: local, one millisecond, id derived from the handle,
    // and `phone` reads back the literal string `"shared"` rather than a number. It
    // consumes no new-conversation quota because it makes no request.
    const space = await this.spaces.create(handle);
    return { id: space.id, phone: phoneOf(space) };
  }

  async getSpace(spaceId: string): Promise<SpectrumSpaceRef> {
    const space = await this.spaces.get(spaceId);
    return { id: space.id, phone: phoneOf(space) };
  }

  async send(ref: SpectrumSpaceRef, parts: readonly SpectrumPart[]): Promise<SpectrumSendResult> {
    const space = await this.spaces.get(ref.id);
    const contents = parts.map((part) => {
      if (part.kind === "text") return text(part.text);
      if (part.kind === "contact_card") return nativeContactCard();
      // Explicit mime type, always: the card's URL ends in a signature, so there is no
      // extension for a receiver to infer from.
      return attachment(new URL(part.url), { mimeType: part.mimeType, name: part.name });
    });

    // ONE `send`, with the parts batched. The first version issued one call per part so a
    // partial failure would be attributable — and the live send showed what that costs:
    // Photon caps a NEW conversation at roughly three messages until the recipient
    // replies, and a lead carrying an image plus text spent two of them. The card landed,
    // the sentence explaining it did not.
    //
    // Batching is now required rather than tidy, and attribution is recovered from the
    // parts list in the log line above the call rather than from one request per block.
    const [first, second, ...rest] = contents;
    const sent = first === undefined
      ? undefined
      : second === undefined
        ? await space.send(first)
        : await space.send(first, second, ...rest);
    const last = (Array.isArray(sent) ? sent.at(-1) : sent) as { id?: string } | undefined;

    return {
      message_id: last?.id ?? `spectrum_${Date.now()}`,
      service: serviceOf(space),
      phone: phoneOf(space),
    };
  }

  async registerUser(): Promise<void> {
    // NOT IMPLEMENTED, and it throws rather than resolving. The Free tier's allowlist is
    // managed in the project dashboard, and the SDK surface read for prompt 10 exposes no
    // API for adding project Users. A silent no-op here would let signup report success
    // for an account whose first outbound is refused with
    // `Target not allowed for this project` — days later, with nothing wrong on the page.
    throw new Error(
      "registerUser is not available in the SDK: add the handle under Users in the "
      + "Photon dashboard, or implement this against the project API before signup runs "
      + "against a live line",
    );
  }
}

function phoneOf(space: unknown): string {
  const value = (space as { phone?: unknown }).phone;
  return typeof value === "string" ? value : "shared";
}

function serviceOf(space: unknown): SpectrumService {
  const value = (space as { service?: unknown }).service;
  return value === "iMessage" || value === "SMS" || value === "RCS" ? value : "unknown";
}
