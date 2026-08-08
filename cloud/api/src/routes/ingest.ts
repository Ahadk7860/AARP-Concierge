// POST /v1/digest, POST /v1/voice-pack, POST /v1/heartbeat, DELETE /v1/users/{id}
//
// Every route here follows the same order, and the order is the point:
//
//   authenticate → validate the body against the frozen schema → check the body's
//   claims against the credential → guard → store
//
// "Trusting the Mac" is explicitly out of scope for this prompt. A digest that names a
// user_id is making a claim, not stating a fact, and the claim is checked against the
// token before anything is written.

import type { FastifyInstance } from "fastify";
import type { ZodType } from "zod";
import type { Logger } from "pino";
import {
  DuplicateDigestError,
  deleteUser,
  deviceBelongsToUser,
  insertDigest,
  latestDigest,
  newDigestId,
  recordHeartbeat,
  upsertVoicePack,
} from "../../../db/src/index.js";
import type { Channel, Digest, DigestV2, VoicePack, VoicePackV2 } from "../../../shared/src/index.js";
import { authenticate, ownsUser } from "../auth.js";
import { duplicate, redactionFailed, send, unauthorized, validation } from "../errors.js";
import { bodyHash, logEvent } from "../logging.js";
import { firstSyncOffer } from "../welcome.js";
import { digestSchema, heartbeatSchema, voicePackSchema } from "../schemas.js";
import { describeViolations, findRedactionViolations } from "../redaction.js";

/**
 * zod's message, flattened to the one-line `detail` string the OpenAPI document
 * requires. Field paths are included; values are NOT — a validation error on an
 * exemplar must not echo the exemplar back.
 */
function detailFrom(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function parse<T>(schema: ZodType<T>, body: unknown): { ok: true; value: T } | { ok: false; detail: string } {
  const result = schema.safeParse(body);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, detail: detailFrom(result.error) };
}

export type IngestDeps = {
  /**
   * The channel, so the first sync can offer the report.
   *
   * Optional: an API built without one still ingests, and the offer is the one thing that
   * does not happen. It is logged either way — a silently absent offer is a funnel step
   * nobody knows is missing.
   */
  channel?: Channel;
};

export function registerIngestRoutes(
  app: FastifyInstance,
  log: Logger,
  deps: IngestDeps = {},
): void {
  // -------------------------------------------------------------------------
  app.post("/v1/digest", async (req, reply) => {
    const principal = await authenticate(req, reply);
    if (principal === null) return reply;

    const parsed = parse(digestSchema, req.body);
    if (!parsed.ok) {
      logEvent(log, { msg: "digest.rejected", route: "/v1/digest", status: 400 });
      return send(reply, 400, validation(parsed.detail));
    }
    const digest = parsed.value as Digest | DigestV2;

    // The body's claim about who it belongs to, checked against the credential.
    if (!ownsUser(principal, digest.user_id)) {
      logEvent(log, { msg: "digest.foreign_user", route: "/v1/digest", status: 401 });
      return send(reply, 401, unauthorized());
    }

    // A device_id the caller does not own is a claim too. Not 401: the caller is who
    // they say they are, the body is malformed.
    if (!(await deviceBelongsToUser(principal.scope, digest.device_id))) {
      return send(
        reply,
        400,
        validation(`device_id ${digest.device_id} is not registered to this user`),
      );
    }

    const digest_id = newDigestId();
    // Asked BEFORE the insert, because after it the answer is always "no".
    const first = (await latestDigest(principal.scope)) === null;
    try {
      const stored = await insertDigest(principal.scope, { digest_id, digest });
      const received_at = new Date().toISOString();

      // THE FIRST SYNC, AND THE OFFER. Prompt 09's other end.
      //
      // People are most curious in the ninety seconds after their history finishes
      // loading, and until this existed the earliest anyone could see their report was
      // 8am tomorrow — we were asking them to sleep on it. The offer goes out exactly
      // once, on the first digest, and names the phrase to text back rather than hinting
      // that one exists.
      //
      // Failure here must not fail the upload: the digest is stored, the Mac is waiting
      // on a 202, and a transport hiccup is not a reason to make it retry a corpus it
      // already delivered.
      if (first && deps?.channel !== undefined) {
        try {
          await deps.channel.send(firstSyncOffer(principal.scope.user_id, digest));
          logEvent(log, {
            msg: "sync.offer_sent",
            route: "/v1/digest",
            user_id: principal.scope.user_id,
          });
        } catch (err) {
          logEvent(log, {
            msg: "sync.offer_failed",
            route: "/v1/digest",
            user_id: principal.scope.user_id,
            violations: err instanceof Error ? err.message : "unknown",
          });
        }
      }
      logEvent(log, {
        msg: "digest.ingested",
        route: "/v1/digest",
        status: 202,
        user_id: principal.scope.user_id,
        device_id: digest.device_id,
        digest_id,
        relationship_count: stored.relationships,
      });
      return reply.code(202).send({ digest_id, received_at });
    } catch (err) {
      if (err instanceof DuplicateDigestError) {
        logEvent(log, { msg: "digest.duplicate", route: "/v1/digest", status: 409 });
        return send(reply, 409, duplicate());
      }
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  app.post("/v1/voice-pack", async (req, reply) => {
    const principal = await authenticate(req, reply);
    if (principal === null) return reply;

    const parsed = parse(voicePackSchema, req.body);
    if (!parsed.ok) {
      logEvent(log, {
        msg: "voice_pack.rejected",
        route: "/v1/voice-pack",
        status: 400,
        body_sha256: bodyHash(req.body),
      });
      return send(reply, 400, validation(parsed.detail));
    }
    const pack = parsed.value as VoicePack | VoicePackV2;

    // THE SECOND is_from_me GUARD. Nothing below this point runs if it fires, and in
    // particular `upsertVoicePack` is never reached: a rejected pack is stored NOWHERE.
    //
    // The whole pack, not `pack.exemplars`. The repository persists
    // `JSON.stringify(pack)`, so every free-text field in it is stored, and
    // `register.apology_openers` holds verbatim message prefixes. CONTRACTS.md § 7.
    const violations = findRedactionViolations(pack);
    if (violations.length > 0) {
      const detail = describeViolations(violations);
      logEvent(log, {
        msg: "voice_pack.redaction_failed",
        route: "/v1/voice-pack",
        status: 422,
        user_id: principal.scope.user_id,
        voice_pack_version: pack.voice_pack_version,
        exemplar_count: pack.exemplars.length,
        violations: detail,
        body_sha256: bodyHash(req.body),
      });
      return send(reply, 422, redactionFailed(detail));
    }

    await upsertVoicePack(principal.scope, pack);
    logEvent(log, {
      msg: "voice_pack.ingested",
      route: "/v1/voice-pack",
      status: 202,
      user_id: principal.scope.user_id,
      voice_pack_version: pack.voice_pack_version,
      exemplar_count: pack.exemplars.length,
    });
    return reply.code(202).send();
  });

  // -------------------------------------------------------------------------
  app.post("/v1/heartbeat", async (req, reply) => {
    const principal = await authenticate(req, reply);
    if (principal === null) return reply;

    const parsed = parse(heartbeatSchema, req.body);
    if (!parsed.ok) return send(reply, 400, validation(parsed.detail));
    const beat = parsed.value;

    if (!ownsUser(principal, principal.scope.user_id)) return send(reply, 401, unauthorized());
    if (beat.device_id !== principal.device_id) {
      return send(reply, 400, validation("device_id does not match the authenticated device"));
    }

    // `digest_as_of` is what the DEVICE last computed, which is not what the server
    // holds. A Mac that has computed a digest it has not uploaded is a real state, and
    // prompt 05's staleness needs to be able to see it.
    await recordHeartbeat(principal.scope, beat.device_id, new Date(), {
      app_version: beat.app_version,
      digest_as_of: beat.digest_as_of,
      macos_version: beat.macos_version ?? null,
      fda_granted: beat.fda_granted ?? null,
    });

    logEvent(log, {
      msg: "heartbeat",
      route: "/v1/heartbeat",
      status: 204,
      user_id: principal.scope.user_id,
      device_id: beat.device_id,
    });
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  app.delete<{ Params: { user_id: string } }>("/v1/users/:user_id", async (req, reply) => {
    const principal = await authenticate(req, reply);
    if (principal === null) return reply;

    // The IDOR. Deleting the wrong account is the least recoverable thing this API can
    // do, and the branded scope type does NOT prevent it — a scope proves you named a
    // user, never that you named the authorized one. 401 rather than 404: a 404 would
    // confirm which user ids do not exist.
    if (!ownsUser(principal, req.params.user_id)) {
      logEvent(log, { msg: "delete.foreign_user", route: "/v1/users/:user_id", status: 401 });
      return send(reply, 401, unauthorized());
    }

    // One operation, and it verifies its own completeness by walking foreign keys from
    // `users`. Throws rather than reporting success if anything survived.
    const result = await deleteUser(principal.scope);
    logEvent(log, {
      msg: "user.deleted",
      route: "/v1/users/:user_id",
      status: 204,
      user_id: req.params.user_id,
      relationship_count: result.verified_tables.length,
    });
    return reply.code(204).send();
  });
}
