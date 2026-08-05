// Registering a user with Photon, and telling the onboarding surface which line to text.
//
// **The line comes from CONFIG, and the probe is why.** AMENDMENT-002 says to resolve the
// user's assigned line by creating the space and reading its `phone`. Against the real
// project that reads back the literal string `"shared"`:
//
//     im.space.create("+16465792868")
//       -> { id: "any;-;+16465792868", phone: "shared" }   1 ms, twice, same id
//
// On a shared pool there is no per-recipient number to resolve, because the line is picked
// at SEND time rather than at assignment time. So `lineFor` reads the project's own number
// — known from the dashboard, verified end to end — and the deep link is legitimately a
// constant on this tier. Not because anybody hard-coded it: because the pool has one
// number per project until a dedicated line is bought.
//
// `StubRegistrar` handing every user a DIFFERENT line stays correct and is not a lie about
// this tier — it models the one we move to, and consuming code must not learn to assume
// constancy from an accident of the free plan.

import type { AssignedLine, Registrar } from "../../shared/src/index.js";
import type { SpectrumPort } from "./spectrum-port.js";

/**
 * The project's line, from config.
 *
 * No default. A registrar that invented a number would produce a deep link opening a
 * thread with a stranger, and the user would have done everything right — so an
 * unconfigured line is a startup failure, not a runtime surprise.
 */
export function configuredLine(env: NodeJS.ProcessEnv = process.env): string {
  const line = env["SPECTRUM_LINE_E164"];
  if (line === undefined || !/^\+[1-9][0-9]{6,14}$/.test(line)) {
    throw new Error(
      "SPECTRUM_LINE_E164 is unset or not E.164. On the shared tier the line cannot be "
      + "resolved from space.phone — it reads 'shared' — so it must be configured.",
    );
  }
  return line;
}

export class SpectrumRegistrar implements Registrar {
  constructor(
    private readonly port: SpectrumPort,
    private readonly line: string = configuredLine(),
  ) {}

  /**
   * Both handles, one call.
   *
   * The Free tier's allowlist is outbound-only and rejects with
   * `Target not allowed for this project`, so this is what makes every later send legal.
   * Registering only the phone is the silent failure: Messages on a Mac frequently sends
   * from the Apple Account email, and an unregistered handle is refused at send time —
   * long after signup, with nothing on the signup page having gone wrong.
   */
  async register(input: { user_id: string; handles: readonly string[] }): Promise<void> {
    if (input.handles.length === 0) throw new Error("registrar_no_handles");
    await this.port.registerUser({ user_id: input.user_id, handles: input.handles });
  }

  /**
   * The line, and a `line_id` that says which project rather than which conversation.
   *
   * Never `space.phone`. Reading that would put the string `"shared"` into a `sms:` link.
   */
  async lineFor(_userId: string): Promise<AssignedLine | null> {
    return { line_id: `project:${this.line}`, handle: this.line };
  }
}
