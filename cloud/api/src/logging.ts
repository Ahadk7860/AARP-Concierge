// Structured JSON to stdout. CONTRACTS.md § 6.
//
// "Log the prompt hash, never the prompt." The same rule applies to everything the Mac
// uploads: an exemplar is the user's own sentence, and a gist is a sentence about
// somebody who never agreed to anything. A bad draft must stay reproducible from
// `(voice_pack_version, gist_id, prompt_version, model_id)` WITHOUT a log full of user
// content sitting in an observability vendor for the next seven years.
//
// The enforcement is structural: routes never receive a logger that could take a
// payload. They call `logEvent` with a fixed set of scalar fields, and there is no
// field on `LogFields` that a string of user content would fit into naturally.

import { createHash } from "node:crypto";
import { pino, type Logger } from "pino";

export type LogFields = {
  msg: string;
  route?: string;
  status?: number;
  user_id?: string;
  device_id?: string;
  digest_id?: string;
  voice_pack_version?: string;
  /** Counts and hashes only. Never the content they summarise. */
  exemplar_count?: number;
  relationship_count?: number;
  body_sha256?: string;
  violations?: string;
  duration_ms?: number;
};

export function makeLogger(destination?: NodeJS.WritableStream): Logger {
  return pino(
    {
      level: process.env["LOG_LEVEL"] ?? "info",
      base: undefined, // no pid/hostname noise
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

/**
 * A content hash, for correlating a rejected upload with what the Mac sent without
 * keeping what the Mac sent.
 */
export function bodyHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body) ?? "").digest("hex").slice(0, 16);
}

export function logEvent(log: Logger, fields: LogFields): void {
  const { msg, ...rest } = fields;
  log.info(rest, msg);
}
