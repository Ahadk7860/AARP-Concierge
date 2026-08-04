// The narrow seam between `SpectrumChannel` and Photon's SDK.
//
// **Not a workaround for the SDK being absent — it is the shape the channel wants.** Three
// reasons, and the third is the one that matters:
//
// 1. The DoD requires the tests to run with **no live line**. A channel that calls the SDK
//    directly can only be tested by having credentials, which means CI cannot run it and
//    every other track inherits a dependency on somebody's account.
// 2. `Channel` is frozen and provider-agnostic; the SDK's surface is enormous (we use
//    roughly 5% of it) and its types leak platform concepts everywhere. This is the
//    aperture, written down.
// 3. **It is the only place a recorded transcript can be substituted for a live call.**
//    Track C's Linq adapter proved the `Channel` seam holds for one implementation; this
//    is what lets a second one be verified without a vendor.
//
// Everything here is expressed in Photon's vocabulary deliberately — `service`, `space`,
// `phone`. Translating to Boi's vocabulary is `spectrum-channel.ts`'s job, and doing it
// here would put the mapping in two places.

/** What Photon calls a conversation. One per recipient, forever. */
export type SpectrumSpaceRef = {
  /** The platform's space id, persisted so `space.create` is called once per user ever. */
  id: string;
  /**
   * The line THIS conversation is on.
   *
   * On the Free tier the pool is shared, so the number differs per recipient — which is
   * why the onboarding deep link cannot be a constant and why `ChannelHealth.line_id` has
   * no single correct value.
   */
  phone: string;
};

/**
 * Photon's four services against Boi's three protocols.
 *
 * `unknown` is a real answer and is not `SMS`. Kept in the vendor's own spelling here so
 * the mapping is visible at one boundary rather than assumed at several.
 */
export type SpectrumService = "iMessage" | "SMS" | "RCS" | "unknown";

export type SpectrumPart =
  | { kind: "text"; text: string }
  | {
      kind: "attachment";
      url: string;
      /**
       * **Explicit, always.** The card is generated and its URL carries a signature
       * rather than an extension, so there is nothing for a receiver to infer from — an
       * attachment with a guessed type is the acquisition artifact arriving as a file
       * nobody can open.
       */
      mimeType: string;
      name: string;
    };

export type SpectrumSendResult = {
  /** The provider's message id. The only moment the `omsg_ -> lmsg_` link exists. */
  message_id: string;
  service: SpectrumService;
  /** The line the message actually went out on. */
  phone: string;
};

/**
 * Everything `SpectrumChannel` needs from Photon, and nothing else.
 *
 * If this grows a method that is not one of these four, check first whether the thing
 * being added belongs above the `Channel` line — that is where the last three "just one
 * more method" requests in this repo turned out to belong.
 */
export interface SpectrumPort {
  /**
   * Resolve or create the conversation with a handle.
   *
   * **Creating a space must not send anything.** Photon defines a "new conversation" as
   * the first message a line SENDS, so resolving an assignment is free of the
   * 50-per-line-per-day quota — which matters because this runs at every signup, and if
   * it did count, onboarding would cap at 50 users a day rather than degrade.
   */
  createSpace(handle: string): Promise<SpectrumSpaceRef>;

  /** Rehydrate a known space. Called on every send after the first. */
  getSpace(spaceId: string): Promise<SpectrumSpaceRef>;

  /** One outbound message, possibly several parts. */
  send(space: SpectrumSpaceRef, parts: readonly SpectrumPart[]): Promise<SpectrumSendResult>;

  /**
   * Register handles as project Users.
   *
   * The Free tier's allowlist is **outbound-only**: a shared line will only message
   * recipients registered to the project, and the rejection is
   * `Target not allowed for this project`. Registering both the phone and the Apple
   * Account email at signup is what makes every later send legal.
   */
  registerUser(input: { user_id: string; handles: readonly string[] }): Promise<void>;
}
