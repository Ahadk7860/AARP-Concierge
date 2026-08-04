// Signup, and the pairing exchange.
//
// NOTE: `contracts/openapi/boi-api.v1.yaml` documents `POST /v1/pair` and nothing for
// signup. The signup surface here (`GET /signup`, `POST /signup`) is therefore
// UNDOCUMENTED — recorded as a contract gap in NOTES.md. It is a web surface rather
// than an API the Mac calls, which is probably why it is absent, but it is a shape
// Track A and Track C can both see and I would rather it were written down.

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Logger } from "pino";
import type { Channel, Registrar } from "../../../shared/src/index.js";
import { z } from "zod";
import {
  bootstrapLookups,
  consumePairingCode,
  createUser,
  findUserIdByPhone,
  getUser,
  issuePairingCode,
  newPairingCode,
  registerDevice,
  type HandleStatus,
  type UserScope,
} from "../../../db/src/index.js";
import { invalidCode, send, validation } from "../errors.js";
import { logEvent } from "../logging.js";
import { newPairingToken, pairingDeepLink, smsDeepLink } from "../welcome.js";
import { FixedWindowLimiter, PAIR_LIMIT } from "../limiter.js";

/** Ten minutes. `contracts/openapi/boi-api.v1.yaml`: "Single use, 10 minute expiry". */
export const PAIRING_TTL_SECONDS = 600;

/**
 * Which country calling codes may sign up. **`1` at launch, and it is a legal invariant
 * rather than a preference.**
 *
 * Both strategy documents say "US only at launch. GDPR grants non-users rights we
 * structurally cannot fulfill" — Boi holds abstractions about people who never signed up
 * to anything, so a European counterparty's right to erasure is one we cannot honour by
 * construction. The regex here accepted `+[1-9]` — any country on earth — and there was
 * no geo gate anywhere else either.
 *
 * **Config, not a literal**, because launch geography is a deploy decision: adding
 * Canada is `BOI_ALLOWED_COUNTRY_CODES=1`, and adding the UK is `1,44` plus a lawyer.
 * A hard-coded `+1` would make the next change a code change and a release.
 */
export function allowedCountryCodes(): string[] {
  return (process.env["BOI_ALLOWED_COUNTRY_CODES"] ?? "1")
    .split(",")
    .map((code) => code.trim())
    .filter((code) => /^[1-9][0-9]{0,2}$/.test(code));
}

/** E.164 shape first, then geography. Two questions, two messages. */
export function countryCodeAllowed(phone: string, allowed = allowedCountryCodes()): boolean {
  return allowed.some((code) => phone.startsWith(`+${code}`));
}

const signupSchema = z
  .object({
    // E.164. The join key for the whole account, so it is validated hard.
    phone_e164: z.string()
      .regex(/^\+[1-9][0-9]{6,14}$/, "must be an E.164 phone number")
      .refine((phone) => countryCodeAllowed(phone), {
        message: "Boi is US-only at launch",
      }),
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
  /**
   * AMENDMENT-002. **REQUIRED**, and it was optional for exactly one commit.
   *
   * Optional-with-a-fallback made the retired cold open the DEFAULT: every deployment and
   * the end-to-end runner would have kept sending first until somebody remembered to pass
   * a registrar. That is a feature flag nobody set, defaulting to the behaviour we have
   * evidence is harmful — a line that initiates to somebody who has not written first
   * gets iMessage's spam-report affordance attached to Boi's first words.
   *
   * `buildServer` defaults it to `StubRegistrar`, so a server with no transport still
   * starts and hands out obviously-fake `+1555…` lines. Loud beats plausible: there is no
   * longer any way to select the old flow by forgetting something.
   */
  registrar: Registrar;
  /** Injected so expiry can be tested by moving the clock, not by sleeping. */
  now: Clock;
  /** Shared so a test can reset it; per-process, which is a real limitation. */
  pairLimiter?: FixedWindowLimiter;
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
  /** AMENDMENT-002: present means the user goes first, prefilled. */
  token?: string | null;
}): string {
  // THE HANDLE IS THAT USER'S LINE, never a constant: the pool is shared and the number
  // differs per recipient.
  const link = input.token
    ? pairingDeepLink({ handle: input.handle, token: input.token })
    : smsDeepLink(input.handle);
  const mismatch = input.status === "mismatch";
  const heading = input.token ? "One tap, and you're set." : "Boi just texted you.";
  const instruction = input.token
    ? `<p>Tap below — it opens Messages with the message already written. Just hit send.</p>`
    : `<p>Open the thread and tap the contact card to save Boi. That keeps these messages
out of your filtered tab.</p>`;
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boi — check your messages</title>
<h1>${heading}</h1>
${instruction}
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

/**
 * The page when the transport is unreachable.
 *
 * An honest 503 rather than a confirmation page with a dead link. Under AMENDMENT-002 the
 * link IS the product's next step, so rendering one that opens a thread with a line the
 * user was never assigned would surface as "I sent it and nothing happened" — which is
 * indistinguishable from the product being broken, and unsupportable.
 */
export function unavailablePage(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boi — try again in a minute</title>
<h1 id="signup-unavailable">We couldn't set up your line.</h1>
<p>Your account exists and nothing was lost. This is on our side — try again in a minute
and it should go through.</p>`;
}

export function registerSignupRoutes(
  app: FastifyInstance,
  log: Logger,
  deps: SignupDeps,
): void {

  /**
   * Signup under AMENDMENT-002: register, resolve, mint, render. No send.
   *
   * Ordering matters and is asserted. Registration happens BEFORE the line is resolved
   * because the line is assigned by registering; the token is minted last because a
   * token that exists before the page can render is a live credential attached to an
   * account the user may never see.
   */
  async function signupUserGoesFirst(
    input: { phone_e164: string; email?: string | undefined; timezone?: string | undefined },
    registrar: Registrar,
    reply: FastifyReply,
  ): Promise<unknown> {
    const existing = await findUserIdByPhone(input.phone_e164);
    const scope = existing ?? (await createUser({
      phone_e164: input.phone_e164,
      email: input.email ?? null,
      timezone: input.timezone ?? undefined,
    })).scope;

    // BOTH HANDLES, IN ONE CALL. Messages on a Mac frequently sends from the Apple
    // Account email rather than the phone number, the transport cannot tell us which
    // Apple will pick, and inbound from an unregistered handle is SILENT — no error
    // anywhere, just a user whose first message vanishes.
    const handles = [input.phone_e164, ...(input.email ? [input.email] : [])];

    let line;
    try {
      await registrar.register({ user_id: scope.user_id, handles });
      line = await registrar.lineFor(scope.user_id);
    } catch (err) {
      // THE TRANSPORT IS DOWN AND THE PAGE MUST SAY SO. Rendering a confirmation page
      // with a dead link would send the user to Messages to text a number that is not
      // theirs — the failure would surface as "I sent it and nothing happened", which is
      // indistinguishable from the product being broken and impossible to support.
      logEvent(log, {
        msg: "signup.registrar_failed",
        route: "/signup",
        user_id: scope.user_id,
        violations: err instanceof Error ? err.message : "unknown",
        status: 503,
      });
      return reply.code(503).type("text/html; charset=utf-8").send(unavailablePage());
    }

    if (line === null) {
      logEvent(log, {
        msg: "signup.no_line",
        route: "/signup",
        user_id: scope.user_id,
        status: 503,
      });
      return reply.code(503).type("text/html; charset=utf-8").send(unavailablePage());
    }

    // Single use, ten minutes, bound to one user — every property the six-digit code
    // has, and none of them weakened because the user no longer sees it.
    const token = await mintUniqueCode(scope, deps.now(), newPairingToken);

    logEvent(log, {
      msg: existing === null ? "signup.created" : "signup.reissued",
      route: "/signup",
      user_id: scope.user_id,
      // The token is a BEARER CREDENTIAL and is never logged, here or anywhere. It rides
      // in a URL and in a message body; a log line is the one place it has no business
      // being, because that is the copy that outlives the thread.
      status: 200,
    });

    return reply
      .type("text/html; charset=utf-8")
      .send(confirmationPage({ handle: line.handle, status: "unknown", token }));
  }

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

    // ---------------------------------------------------------------- AMENDMENT-002
    //
    // The user opens the thread. Nothing is sent from here: a line that initiates to
    // somebody who has not written first gets iMessage's spam-report affordance attached,
    // which is worse than the filtered tab the old flow was avoiding.
    return await signupUserGoesFirst(input, deps.registrar, reply);
  });

  // -------------------------------------------------------------------------
  // The pre-AMENDMENT-002 signup handler stood here: create the user, SEND FIRST with
  // a contact card, text a six-digit code, render a confirmation page pointing at a
  // constant handle. It is deleted rather than parked behind a flag or a spare route —
  // a retired route nobody routes to is still a route somebody can hit, and an optional
  // registrar with a legacy fallback is a feature flag nobody set, defaulting to the
  // behaviour the filter test showed is harmful.
  //
  // What survives, deliberately: `welcomeMessage` (a frozen fixture conforms to it),
  // `pairingCodeMessage`, and `POST /v1/pair` with six-digit codes, because Track F is
  // mid-flight against that endpoint and the amendment's own fallback is the old flow
  // PLUS the deep link rather than the old flow alone.

  // -------------------------------------------------------------------------
  const pairLimiter = deps.pairLimiter ?? new FixedWindowLimiter(PAIR_LIMIT);

  app.post("/v1/pair", async (req, reply) => {
    // UNAUTHENTICATED, six digits, and it returns a device_token AND the user_salt.
    // A million codes with a ten-minute window is minutes of brute force unthrottled.
    const source = req.ip ?? "unknown";
    const decision = pairLimiter.check(`pair:${source}`, deps.now());
    if (!decision.allowed) {
      logEvent(log, { msg: "pair.rate_limited", route: "/v1/pair", status: 429 });
      return reply
        .code(429)
        .header("retry-after", String(decision.retry_after_seconds))
        .send({ error: "rate_limited" });
    }

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

async function mintUniqueCode(
  scope: UserScope,
  now: Date,
  mint: () => string = newPairingCode,
): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = mint();
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


