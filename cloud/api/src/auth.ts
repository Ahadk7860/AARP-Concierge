// Bearer device-token authentication.
//
// The scope a route acts on comes from the CREDENTIAL and never from the request. That
// is the whole rule, and it is the one this track already got wrong once at the
// database layer: a `UserScope` proves you named a user, never that you named the
// authorized user. See `unsafeScopeFromUserId` in cloud/db/src/scope.ts — it does not
// appear anywhere in this directory, deliberately.

import type { FastifyReply, FastifyRequest } from "fastify";
import { bootstrapLookups, type UserScope } from "../../db/src/index.js";
import { send, unauthorized } from "./errors.js";

export type Principal = { scope: UserScope; device_id: string };

/** Pulls the token out of `Authorization: Bearer <token>`, or null. */
export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Resolve the caller, or send `401 {"error":"unauthorized"}` and return null.
 *
 * Every failure mode collapses to the same response and the same shape: no token, a
 * malformed token, a token for a user that no longer exists, and a token whose secret
 * half is wrong are indistinguishable from outside. Distinguishing them would let a
 * caller enumerate which user ids exist.
 */
export async function authenticate(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<Principal | null> {
  const token = bearerToken(req);
  if (token === null) {
    send(reply, 401, unauthorized());
    return null;
  }

  const auth = await bootstrapLookups.authenticateDeviceToken(token);
  if (auth === null) {
    send(reply, 401, unauthorized());
    return null;
  }
  return auth;
}

/**
 * The IDOR check, for routes that name a user in the path or body.
 *
 * `DELETE /v1/users/{id}` is where getting this wrong is unrecoverable, so it is a
 * named function rather than an inline comparison a route can forget to write.
 */
export function ownsUser(principal: Principal, claimedUserId: string): boolean {
  return principal.scope.user_id === claimedUserId;
}
