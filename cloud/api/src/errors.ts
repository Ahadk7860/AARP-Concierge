// The error bodies, exactly as CONTRACTS.md § 2 and the OpenAPI document give them.
//
// CONTRACTS.md § 6: `{ "error": "<slug>", "detail"?: string }`, slugs lowercase snake.
// Centralised so a route cannot invent a fifth shape, and so the OpenAPI conformance
// test has one place to check.

import type { FastifyReply } from "fastify";

export type ErrorBody = { error: string; detail?: string };

export const unauthorized = (): ErrorBody => ({ error: "unauthorized" });
export const validation = (detail: string): ErrorBody => ({ error: "validation", detail });
export const duplicate = (): ErrorBody => ({ error: "duplicate" });
export const redactionFailed = (detail: string): ErrorBody => ({
  error: "redaction_failed",
  detail,
});
export const invalidCode = (): ErrorBody => ({ error: "invalid_code" });
export const badSignature = (): ErrorBody => ({ error: "bad_signature" });

export function send(reply: FastifyReply, status: number, body: ErrorBody): FastifyReply {
  return reply.code(status).send(body);
}
