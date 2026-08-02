// Signup, and the pairing exchange.
//
// NOTE: `contracts/openapi/boi-api.v1.yaml` documents `POST /v1/pair` and nothing for
// signup. The signup surface here (`GET /signup`, `POST /signup`) is therefore
// UNDOCUMENTED — recorded as a contract gap in NOTES.md. It is a web surface rather
// than an API the Mac calls, which is probably why it is absent, but it is a shape
// Track A and Track C can both see and I would rather it were written down.

import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { Channel } from "../../../shared/src/index.js";
import { z } from "zod";
import {
  bootstrapLookups,
  consumePairingCode,
  createUser,
  findUserIdByPhone,
  getUser,
  insertOutboundMessage,
  issuePairingCode,
  markOutboundSent,
  newOutboundMessageId,
  newPairingCode,
  registerDevice,
  setHandleStatus,
  type HandleStatus,
  type UserScope,
} from "../../../db/src/index.js";
import { invalidCode, send, validation } from "../errors.js";
import { logEvent } from "../logging.js";
import { boiHandle, smsDeepLink, welcomeMessage } from "../welcome.js";

/** Ten minutes. `contracts/openapi/boi-api.v1.yaml`: "Single use, 10 minute expiry". */
export const PAIRING_TTL_SECONDS = 600;

const signupSchema = z
  .object({
    // E.164. The join key for the whole account, so it is validated hard.
    phone_e164: z.string().regex(/^\+[1-9][0-9]{6,14}$/, "must be an E.164 phone number"),
    email: z.string().email().optional(),
    // "Signup: phone, email, terms." An unchecked box is not consent.
    accept_terms: z.literal(true),
    timezone: z.string().optional(),
  })
  .strict();

const pairSchema = z
  .object({
    code: z.string().regex(/^[0-9]{6}$/),
    device_id: z.string(),
  })
  .strict();

export type Clock = () => Date;

export type SignupDeps = {
  channel: Channel;
  /** Injected so expiry can be tested by moving the clock, not by sleeping. */
  now: Clock;
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/**
 * The confirmation page.
 *
 * Deliberately plain — the prompt puts visual design out of scope. The one thing it
 * must get right is the `sms:` link, because that link is what carries the user into
 * the thread Boi has already created.
 */
export function confirmationPage(input: {
  handle: string;
  status: HandleStatus;
}): string {
  const link = smsDeepLink(input.handle);
  const mismatch = input.status === "mismatch";
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boi — check your messages</title>
<h1>Boi just texted you.</h1>
<p>Open the thread and tap the contact card to save Boi. That keeps these messages out
of your filtered tab.</p>
<p><a id="open-thread" href="${escapeHtml(link)}">Open Messages</a></p>
<p>Boi's number: <code>${escapeHtml(input.handle)}</code></p>
${
  mismatch
    ? `<p id="handle-mismatch" role="alert"><strong>Heads up:</strong> that number
doesn't look like it's registered to iMessage, so Boi's message arrived as a green SMS.
If you use iMessage on a different number or an Apple ID email, sign up with that one
instead — otherwise some things won't work.</p>`
    : ""
}`;
}

export function registerSignupRoutes(
  app: FastifyInstance,
  log: Logger,
  deps: SignupDeps,
): void {
  // -------------------------------------------------------------------------
  app.get("/signup", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boi — sign up</title>
<h1>Boi</h1>
<form method="post" action="/signup">
  <label>Phone (the one your iMessage uses)
    <input name="phone_e164" type="tel" placeholder="+14155550142" required></label>
  <label>Email <input name="email" type="email"></label>
  <label><input name="accept_terms" type="checkbox" value="true" required> I accept the terms</label>
  <button type="submit">Text me</button>
</form>`);
  });

  // -------------------------------------------------------------------------
  app.post("/signup", async (req, reply) => {
    const raw = req.body as Record<string, unknown> | undefined;
    // The HTML form posts `accept_terms` as the string "true"; JSON clients send a
    // boolean. Normalise before validating rather than loosening the schema to accept
    // any truthy value — "false" is truthy as a string.
    const body = { ...raw };
    if (body["accept_terms"] === "true") body["accept_terms"] = true;
    if (body["email"] === "") delete body["email"];

    const parsed = signupSchema.safeParse(body);
    if (!parsed.success) {
      return send(
        reply,
        400,
        validation(
          parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
        ),
      );
    }
    const input = parsed.data;

    // Phone is the join key, and `users.phone_e164` is unique. Signing up twice is a
    // normal thing for a person to do, so it re-sends rather than erroring.
    const existing = await findUserIdByPhone(input.phone_e164);
    if (existing !== null) {
      const user = await getUser(existing);
      logEvent(log, { msg: "signup.existing", route: "/signup", user_id: existing.user_id });
      return reply
        .type("text/html; charset=utf-8")
        .send(confirmationPage({ handle: boiHandle(), status: user?.handle_status ?? "unknown" }));
    }

    const { scope } = await createUser({
      phone_e164: input.phone_e164,
      email: input.email ?? null,
      timezone: input.timezone ?? undefined,
    });

    // THE SEND HAPPENS BEFORE THE RESPONSE RETURNS. Not queued, not fired and
    // forgotten: the confirmation page tells the user to go look at a message, so the
    // message has to exist by the time they read that sentence.
    const message = welcomeMessage(scope.user_id);
    let status: HandleStatus = "unreachable";
    try {
      const result = await deps.channel.send(message);

      // HANDLE-MISMATCH DETECTION. `imessage` means the handle they typed is registered
      // to iMessage. Anything else means it is not, and we know NOW — before they have
      // downloaded the Mac app — rather than after the first brief lands as a green
      // text and nothing works properly.
      status = result.protocol === "imessage" ? "imessage" : "mismatch";

      await insertOutboundMessage(scope, {
        message_id: newOutboundMessageId(),
        idempotency_key: message.idempotency_key,
        blocks: message.blocks,
      });
      await markOutboundSent(scope, message.idempotency_key, {
        protocol: result.protocol,
        provider: result.provider,
        provider_message_id: result.message_id,
        line_id: result.line_id,
      });
    } catch (err) {
      // A line that is banned or down is not the user's problem to solve on this page,
      // but it must not be reported as success either.
      logEvent(log, {
        msg: "signup.send_failed",
        route: "/signup",
        user_id: scope.user_id,
        violations: err instanceof Error ? err.message : "unknown",
      });
    }

    await setHandleStatus(scope, status);

    // The pairing code is minted here so it exists the moment the Mac app asks for one.
    const code = await mintUniqueCode(scope, deps.now());

    logEvent(log, {
      msg: "signup.created",
      route: "/signup",
      user_id: scope.user_id,
      status: status === "imessage" ? 200 : 409,
    });

    return reply
      .type("text/html; charset=utf-8")
      .header("x-boi-pairing-code", code) // dev affordance; the real code arrives by text
      .send(confirmationPage({ handle: boiHandle(), status }));
  });

  // -------------------------------------------------------------------------
  app.post("/v1/pair", async (req, reply) => {
    const parsed = pairSchema.safeParse(req.body);
    if (!parsed.success) {
      // The document gives /v1/pair a 404 for a bad code and no 400. A malformed body
      // is still a validation error, and inventing a 400 here would be a shape Track A
      // has not been told about — so a six-digit-shaped failure collapses into the
      // documented 404, which is also what stops this endpoint being a code oracle.
      return send(reply, 404, invalidCode());
    }
    const { code, device_id } = parsed.data;
    const now = deps.now();

    const scope = await bootstrapLookups.resolvePairingCode(code, now);
    if (scope === null) {
      logEvent(log, { msg: "pair.invalid_code", route: "/v1/pair", status: 404 });
      return send(reply, 404, invalidCode());
    }

    // Single use. Burning the code and issuing the token must not be separable: if the
    // consume fails, somebody else already used it in the last few milliseconds.
    const consumed = await consumePairingCode(scope, code, now);
    if (!consumed) {
      logEvent(log, { msg: "pair.already_used", route: "/v1/pair", status: 404 });
      return send(reply, 404, invalidCode());
    }

    const user = await getUser(scope);
    if (user === null) return send(reply, 404, invalidCode());

    const { device_token } = await registerDevice(scope, { device_id });

    logEvent(log, {
      msg: "pair.paired",
      route: "/v1/pair",
      status: 200,
      user_id: scope.user_id,
      device_id,
    });

    return reply.code(200).send({
      user_id: scope.user_id,
      device_token,
      // base64 rather than hex: it is 32 raw bytes, and the Mac puts it straight into
      // the Keychain. CONTRACTS.md § 7 says "any 32 bytes" against the stub.
      user_salt: user.user_salt.toString("base64"),
    });
  });
}

/**
 * A six-digit code that no other user currently holds.
 *
 * `issuePairingCode` guarantees this under an advisory lock and throws if the code is
 * live elsewhere; with a ten-minute window and a million codes a collision is rare, and
 * retrying is cheaper than widening the code.
 */
async function mintUniqueCode(scope: UserScope, now: Date): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = newPairingCode();
    try {
      await issuePairingCode(scope, { code, ttl_seconds: PAIRING_TTL_SECONDS, now });
      return code;
    } catch {
      // Taken. Draw again — never derive the next one from this one, which would make
      // codes predictable from an observed collision.
    }
  }
  throw new Error("could not mint an unused pairing code in 10 attempts");
}


