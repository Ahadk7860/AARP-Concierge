import type { ChatReply } from "../../shared/src/contracts.js";
import type { WaitingOnMeEvidenceRow, WaitingOnMeResult } from "./waiting-on-me.js";

/** A valid chat_reply must carry a horizon even when its input omitted one. */
export const UNKNOWN_SYNC_HORIZON = "1970-01-01T00:00:00.000Z";

export type RenderedClaim = {
  contact_id: string;
  display: string;
  relationship_claim: string;
};

/** Untrusted output of the eventual renderer/model boundary. */
export type RenderedWaitingOnMeAnswer = {
  text: string;
  claims: RenderedClaim[];
};

export type WaitingOnMeRenderer = (
  rows: readonly WaitingOnMeEvidenceRow[],
) => unknown;

const CONTACT_ID = /^h_[0-9a-f]{8,32}$/;
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSyncHorizon(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const parsed = new Date(value);
  // JSON Schema `date-time` accepts UTC timestamps both with and without fractional
  // seconds. Preserve the producer's representation in the reply contract.
  return RFC3339_DATE_TIME.test(value) && !Number.isNaN(parsed.getTime());
}

function parseEvidence(input: unknown): WaitingOnMeResult | null {
  if (!isRecord(input) || !exactKeys(input, ["name", "synced_through", "rows"])) return null;
  if (input.name !== "waiting_on_me" || !validSyncHorizon(input.synced_through) || !Array.isArray(input.rows)) {
    return null;
  }
  if (input.rows.length > 3) return null;

  const rows: WaitingOnMeEvidenceRow[] = [];
  const seen = new Set<string>();
  for (const candidate of input.rows) {
    if (!isRecord(candidate) || !exactKeys(candidate, ["contact_id", "display", "open_thread"])) return null;
    if (
      typeof candidate.contact_id !== "string"
      || !CONTACT_ID.test(candidate.contact_id)
      || seen.has(candidate.contact_id)
      || typeof candidate.display !== "string"
      || candidate.display.trim() === ""
      || candidate.display.length > 64
      || typeof candidate.open_thread !== "string"
      || candidate.open_thread.trim() === ""
      || candidate.open_thread.length > 140
    ) return null;
    seen.add(candidate.contact_id);
    rows.push({
      contact_id: candidate.contact_id,
      display: candidate.display,
      open_thread: candidate.open_thread,
    });
  }

  return { name: "waiting_on_me", synced_through: input.synced_through, rows };
}

export function freshnessDisclosure(syncedThrough: string): string {
  const at = new Date(syncedThrough);
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }).format(at);
  return `As of ${date} at ${time} UTC.`;
}

/**
 * The sole licensed grammar for this first query. Past tense is intentional: a digest
 * describes the last sync, not the present. Any renderer rewrite into "is", "has", or
 * another current-tense assertion fails the exact-text gate below.
 */
export function renderLicensedClaims(claims: readonly RenderedClaim[]): string {
  return claims
    .map((claim) => `${claim.display} had this open at the last sync: ${claim.relationship_claim}.`)
    .join(" ");
}

export function deterministicWaitingOnMeRenderer(
  rows: readonly WaitingOnMeEvidenceRow[],
): RenderedWaitingOnMeAnswer {
  const claims = rows.map((row): RenderedClaim => ({
    contact_id: row.contact_id,
    display: row.display,
    relationship_claim: row.open_thread,
  }));
  return { text: renderLicensedClaims(claims), claims };
}

function parseRendered(value: unknown): RenderedWaitingOnMeAnswer | null {
  if (!isRecord(value) || !exactKeys(value, ["text", "claims"])) return null;
  if (typeof value.text !== "string" || value.text.trim() === "" || !Array.isArray(value.claims)) return null;

  const claims: RenderedClaim[] = [];
  for (const candidate of value.claims) {
    if (!isRecord(candidate) || !exactKeys(candidate, ["contact_id", "display", "relationship_claim"])) return null;
    if (
      typeof candidate.contact_id !== "string"
      || typeof candidate.display !== "string"
      || typeof candidate.relationship_claim !== "string"
    ) return null;
    claims.push({
      contact_id: candidate.contact_id,
      display: candidate.display,
      relationship_claim: candidate.relationship_claim,
    });
  }
  return { text: value.text, claims };
}

/**
 * Validate the renderer against only the query rows it was given. The exact text check
 * means every displayed name, number, date/time fragment, and relationship assertion
 * comes from one of those rows; extra prose has no route through the gate.
 */
export function validateRenderedAnswer(
  renderedValue: unknown,
  evidenceRows: readonly WaitingOnMeEvidenceRow[],
): RenderedWaitingOnMeAnswer | null {
  const rendered = parseRendered(renderedValue);
  if (rendered === null || rendered.claims.length === 0 || rendered.claims.length > evidenceRows.length) return null;

  const licensed = new Map(evidenceRows.map((row) => [row.contact_id, row]));
  const seen = new Set<string>();
  for (const claim of rendered.claims) {
    const row = licensed.get(claim.contact_id);
    if (
      row === undefined
      || seen.has(claim.contact_id)
      || claim.display !== row.display
      || claim.relationship_claim !== row.open_thread
    ) return null;
    seen.add(claim.contact_id);
  }

  // This is also the stale-present-tense gate. The only licensed wrapper says "had"
  // and anchors the statement to the last sync. A renderer cannot turn row evidence
  // into a claim about what is true now.
  if (rendered.text !== renderLicensedClaims(rendered.claims)) return null;
  return rendered;
}

function decline(syncedThrough: string, text: string): ChatReply {
  return {
    schema_version: "chat_reply.v1",
    kind: "decline",
    text,
    synced_through: syncedThrough,
    licenses: [],
  };
}

/** Compose a contract-valid answer or fail closed to a deterministic decline. */
export function composeWaitingOnMeReply(
  input: unknown,
  renderer: WaitingOnMeRenderer = deterministicWaitingOnMeRenderer,
): ChatReply {
  const evidence = parseEvidence(input);
  if (evidence === null) {
    return decline(UNKNOWN_SYNC_HORIZON, "I can't answer because sync freshness or licensed evidence is unavailable.");
  }

  const freshness = freshnessDisclosure(evidence.synced_through);
  if (evidence.rows.length === 0) {
    return decline(
      evidence.synced_through,
      `I don't have a licensed open question to point to. ${freshness}`,
    );
  }

  let renderedValue: unknown;
  try {
    renderedValue = renderer(evidence.rows);
  } catch {
    return decline(
      evidence.synced_through,
      `I can't answer that safely from the licensed relationship evidence. ${freshness}`,
    );
  }
  const rendered = validateRenderedAnswer(renderedValue, evidence.rows);
  if (rendered === null) {
    return decline(
      evidence.synced_through,
      `I can't answer that safely from the licensed relationship evidence. ${freshness}`,
    );
  }

  return {
    schema_version: "chat_reply.v1",
    kind: "answer",
    text: `${rendered.text} ${freshness}`,
    synced_through: evidence.synced_through,
    licenses: rendered.claims.map((claim) => ({
      contact_id: claim.contact_id,
      display: claim.display,
      reason: claim.relationship_claim,
    })),
  };
}
