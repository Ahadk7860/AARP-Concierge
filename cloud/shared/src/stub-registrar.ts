// A `Registrar` that registers nothing, for every consumer that is not Spectrum.
//
// Beside `StubChannel` and for the same reason: every track has to be able to reach a
// green Definition of Done without running another track's code, and until prompt 10
// there is no real transport to register anybody with.
//
// It is a stub with OPINIONS, in the two places where a permissive stub would let a
// consumer develop against something production rejects — the mistake `StubChannel`'s own
// `normalizeInbound` was retyped to prevent.

import type { AssignedLine, Registrar } from "./contracts.js";

export type StubRegistrarMode = "up" | "unreachable";

/**
 * Shared-pool behaviour, faked deterministically.
 *
 * **Every user gets a DIFFERENT line**, derived from their id. A stub that handed out one
 * constant would let a caller build the deep link from a hard-coded number and pass every
 * test — which is precisely the bug AMENDMENT-002 exists to prevent, since the shared
 * pool means the handle differs per recipient.
 */
export class StubRegistrar implements Registrar {
  /** What was registered, per user, in call order. The test surface. */
  readonly registered = new Map<string, string[]>();
  /** Every `register` call as it arrived, so a test can assert ONE call with both handles. */
  readonly calls: Array<{ user_id: string; handles: readonly string[] }> = [];

  constructor(private mode: StubRegistrarMode = "up") {}

  setMode(mode: StubRegistrarMode): void {
    this.mode = mode;
  }

  async register(input: { user_id: string; handles: readonly string[] }): Promise<void> {
    if (this.mode === "unreachable") {
      // A transport that is down at signup must be a visible failure, not an empty
      // registration that fails later as silence.
      throw new Error("registrar_unreachable");
    }
    if (input.handles.length === 0) {
      // Registering nobody is never what a caller meant, and the consequence is a user
      // whose inbound is rejected by the transport with no error on our side.
      throw new Error("registrar_no_handles");
    }
    this.calls.push({ user_id: input.user_id, handles: [...input.handles] });
    const existing = this.registered.get(input.user_id) ?? [];
    this.registered.set(input.user_id, [...existing, ...input.handles]);
  }

  async lineFor(userId: string): Promise<AssignedLine | null> {
    if (this.mode === "unreachable") throw new Error("registrar_unreachable");
    // A line is assigned by registering, so asking about an unregistered user is `null`
    // rather than a fabricated number — the caller has to handle "no line yet", because
    // in production it is a real state.
    if (!this.registered.has(userId)) return null;
    return { line_id: `line_${hash(userId)}`, handle: lineHandle(userId) };
  }
}

/** `+1555` plus seven digits derived from the id: stable per user, distinct across users. */
function lineHandle(userId: string): string {
  return `+1555${hash(userId).slice(0, 7)}`;
}

function hash(value: string): string {
  let n = 0;
  for (const ch of value) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return String(n).padStart(10, "0").slice(0, 10);
}
