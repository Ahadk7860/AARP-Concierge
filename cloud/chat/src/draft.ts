import type { DraftDelivery } from "../../shared/src/contracts.js";

const CONTACT_ID = /^h_[0-9a-f]{8,32}$/;
const VOICE_PACK_VERSION = /^vp_[0-9a-f]{8,16}$/;
const FACT_CATEGORIES = ["dates", "times", "places", "amounts", "names"] as const;
const REGISTER = ["casual", "warm", "terse", "formal", "mixed"] as const;
const SHAPE = ["question_from_them", "statement_from_them", "statement_from_you", "plan_unresolved", "none"] as const;
const ANSWERED = ["question_from_them", "statement_from_them", "plan_unresolved", "none"] as const;
const RELATIONSHIP_KIND = ["close_friend", "logistics", "work", "family", "dormant_close", "other"] as const;

type FactCategory = typeof FACT_CATEGORIES[number];
type Register = typeof REGISTER[number];
type ExchangeShape = typeof SHAPE[number];
type Answered = typeof ANSWERED[number];

export type LicensedFacts = Record<FactCategory, string[]>;

export type DraftProviderInput = {
  understanding: {
    register: Register;
    relationship_kind: typeof RELATIONSHIP_KIND[number];
    open_thread: string;
    last_exchange_shape: ExchangeShape;
    topics: string[];
    cadence_norm: string | null;
  };
  facts: LicensedFacts;
  /** Redacted user-authored messages only. Counterpart prose is never projected here. */
  voice_exemplars: Array<{ text: string; answered: Answered; register: Register }>;
};

export type DraftProviderClaim = {
  source: "open_thread" | "topic";
  value: string;
};

export type DraftProviderOutput = {
  text: string;
  claims: DraftProviderClaim[];
};

export interface FollowUpDraftProvider {
  generate(input: DraftProviderInput): Promise<unknown>;
}

/** The successful handoff deliberately contains no display name, handle, or send action. */
export type DraftProposal = { contact_id: string; text: string };

export type DraftProposalOutcome =
  | { kind: "proposal"; proposal: DraftProposal }
  | {
    kind: "decline";
    reason: "invalid_input" | "provider_failure" | "unlicensed_output";
  };

type DraftSource = {
  contactId: string;
  providerInput: DraftProviderInput;
  register: {
    median_len_chars: number;
    p90_len_chars?: number;
    avg_msgs_per_burst: number;
    punctuation: string;
    emoji_rate: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isEnum<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function parseFacts(value: unknown): LicensedFacts | null {
  if (!isRecord(value) || !exactKeys(value, FACT_CATEGORIES)) return null;
  const facts = {} as LicensedFacts;
  for (const category of FACT_CATEGORIES) {
    const candidates = value[category];
    if (!Array.isArray(candidates) || candidates.length > 20) return null;
    const parsed: string[] = [];
    for (const candidate of candidates) {
      if (!boundedText(candidate, 80)) return null;
      parsed.push(candidate);
    }
    facts[category] = parsed;
  }
  return facts;
}

function parseUnderstanding(value: unknown): DraftProviderInput["understanding"] | null {
  if (!isRecord(value)) return null;
  if (
    !isEnum(value.register, REGISTER)
    || !isEnum(value.relationship_kind, RELATIONSHIP_KIND)
    || !boundedText(value.open_thread, 140)
    || !isEnum(value.last_exchange_shape, SHAPE)
    || !Array.isArray(value.topics)
    || value.topics.length > 8
    || !(value.cadence_norm === null || boundedText(value.cadence_norm, 140))
  ) return null;
  const topics: string[] = [];
  for (const topic of value.topics) {
    if (!boundedText(topic, 40) || topic.trim().split(/\s+/).length > 3) return null;
    topics.push(topic);
  }
  return {
    register: value.register,
    relationship_kind: value.relationship_kind,
    open_thread: value.open_thread,
    last_exchange_shape: value.last_exchange_shape,
    topics,
    cadence_norm: value.cadence_norm,
  };
}

function parseRegister(value: unknown): DraftSource["register"] | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.median_len_chars !== "number" || value.median_len_chars < 0
    || !(value.p90_len_chars === undefined || (typeof value.p90_len_chars === "number" && value.p90_len_chars >= 0))
    || typeof value.avg_msgs_per_burst !== "number" || value.avg_msgs_per_burst < 0
    || typeof value.punctuation !== "string"
    || typeof value.emoji_rate !== "number" || value.emoji_rate < 0 || value.emoji_rate > 1
  ) return null;
  return {
    median_len_chars: value.median_len_chars,
    p90_len_chars: value.p90_len_chars,
    avg_msgs_per_burst: value.avg_msgs_per_burst,
    punctuation: value.punctuation,
    emoji_rate: value.emoji_rate,
  };
}

function parseVoicePack(value: unknown, contactId: string): {
  exemplars: DraftProviderInput["voice_exemplars"];
  register: DraftSource["register"];
} | null {
  if (!isRecord(value)) return null;
  if (
    value.schema_version !== "voice_pack.v2"
    || typeof value.voice_pack_version !== "string"
    || !VOICE_PACK_VERSION.test(value.voice_pack_version)
    || value.scope !== "contact"
    || value.contact_id !== contactId
    || !Array.isArray(value.exemplars)
    || value.exemplars.length === 0
    || value.exemplars.length > 40
  ) return null;
  if (value.n_exemplars !== undefined && value.n_exemplars !== value.exemplars.length) return null;
  const register = parseRegister(value.register);
  if (register === null) return null;
  const exemplars: DraftProviderInput["voice_exemplars"] = [];
  for (const candidate of value.exemplars) {
    if (
      !isRecord(candidate)
      || !exactKeys(candidate, ["text", "answered", "register"])
      || !boundedText(candidate.text, 200)
      || !isEnum(candidate.answered, ANSWERED)
      || !isEnum(candidate.register, REGISTER)
    ) return null;
    exemplars.push({ text: candidate.text, answered: candidate.answered, register: candidate.register });
  }
  return { exemplars, register };
}

function selectDraftSource(digest: unknown, contactId: string, voicePack: unknown): DraftSource | null {
  if (!CONTACT_ID.test(contactId) || !isRecord(digest) || digest.schema_version !== "digest.v2" || !Array.isArray(digest.relationships)) {
    return null;
  }
  const matches = digest.relationships.filter((candidate) => isRecord(candidate) && candidate.contact_id === contactId);
  if (matches.length !== 1) return null;
  const relationship = matches[0];
  if (!isRecord(relationship) || relationship.is_group !== false) return null;
  const understanding = parseUnderstanding(relationship.understanding);
  const facts = parseFacts(relationship.facts);
  const voice = parseVoicePack(voicePack, contactId);
  if (understanding === null || facts === null || voice === null) return null;
  return {
    contactId,
    providerInput: { understanding, facts, voice_exemplars: voice.exemplars },
    register: voice.register,
  };
}

function parseProviderOutput(value: unknown): DraftProviderOutput | null {
  if (!isRecord(value) || !exactKeys(value, ["text", "claims"]) || !boundedText(value.text, 1000) || !Array.isArray(value.claims)) {
    return null;
  }
  if (value.claims.length === 0 || value.claims.length > 9) return null;
  const claims: DraftProviderClaim[] = [];
  for (const candidate of value.claims) {
    if (
      !isRecord(candidate)
      || !exactKeys(candidate, ["source", "value"])
      || !(candidate.source === "open_thread" || candidate.source === "topic")
      || typeof candidate.value !== "string"
    ) return null;
    claims.push({ source: candidate.source, value: candidate.value });
  }
  return { text: value.text, claims };
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenAligned(needle: string, haystack: string): boolean {
  if (needle.length === 0) return false;
  return new RegExp(`(^|[^a-z0-9'])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9']|$)`, "i").test(haystack);
}

function isLicensedSpecific(value: string, facts: LicensedFacts): boolean {
  const found = normalise(value);
  return FACT_CATEGORIES.some((category) => facts[category].some((allowed) => {
    const licensed = normalise(allowed);
    return licensed === found || tokenAligned(found, licensed) || tokenAligned(licensed, found);
  }));
}

/**
 * Conservative, deterministic surface extraction. The live-provider gate remains false
 * until the 50-case run exercises the same boundary; this is defense in depth, not NER.
 */
function unlicensedSpecifics(text: string, facts: LicensedFacts): string[] {
  const patterns = [
    /(?:[$£€]\s?\d+(?:\.\d{1,2})?|\b\d+(?:\.\d{1,2})?\s?(?:dollars?|bucks?|usd)\b)/giu,
    /\b(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|today|tonight|tomorrow)\b/giu,
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/giu,
    /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/giu,
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/gu,
    /\b(?:at|in|near|by|from|to)\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,3})\b/gu,
    /\b(?:with|ask|tell|bring|meet)\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,2})\b/gu,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[0];
      if (!isLicensedSpecific(value, facts)) found.push(value);
    }
  }
  return found;
}

function lengthLimit(register: DraftSource["register"]): number {
  const p90 = register.p90_len_chars ?? register.median_len_chars;
  return Math.max(register.median_len_chars * register.avg_msgs_per_burst, p90) + 30;
}

function claimsAreLicensed(claims: readonly DraftProviderClaim[], input: DraftProviderInput): boolean {
  const seen = new Set<string>();
  return claims.every((claim) => {
    const key = `${claim.source}:${claim.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return claim.source === "open_thread"
      ? claim.value === input.understanding.open_thread
      : input.understanding.topics.includes(claim.value);
  });
}

function registerMatches(text: string, register: DraftSource["register"]): boolean {
  const trimmed = text.trim();
  if (register.punctuation.startsWith("lowercase")) {
    const first = [...trimmed].find((character) => /[A-Za-z]/.test(character));
    if (first !== undefined && first !== first.toLowerCase()) return false;
  }
  if (register.punctuation.endsWith("no_period") && trimmed.endsWith(".")) return false;
  // Broad pictograph coverage is sufficient for the low-rate refusal gate.
  if (register.emoji_rate < 0.02 && /\p{Extended_Pictographic}/u.test(trimmed)) return false;
  return true;
}

export async function proposeFollowUpDraft(
  digest: unknown,
  contactId: string,
  voicePack: unknown,
  provider: FollowUpDraftProvider,
): Promise<DraftProposalOutcome> {
  const source = selectDraftSource(digest, contactId, voicePack);
  if (source === null) return { kind: "decline", reason: "invalid_input" };

  let value: unknown;
  try {
    // The provider receives a disposable copy. Validation stays anchored to the
    // pre-call license, so an adapter cannot expand `facts` or replace the selected
    // open thread by mutating its input before returning prose.
    value = await provider.generate(structuredClone(source.providerInput));
  } catch {
    return { kind: "decline", reason: "provider_failure" };
  }
  const output = parseProviderOutput(value);
  if (
    output === null
    || output.text.length > lengthLimit(source.register)
    || !registerMatches(output.text, source.register)
    || !claimsAreLicensed(output.claims, source.providerInput)
    || unlicensedSpecifics(output.text, source.providerInput.facts).length > 0
  ) return { kind: "decline", reason: "unlicensed_output" };

  return { kind: "proposal", proposal: { contact_id: source.contactId, text: output.text } };
}

export function composeDraftDelivery(
  proposal: DraftProposal,
  recipient: DraftDelivery["recipient"],
): DraftDelivery | null {
  if (!CONTACT_ID.test(proposal.contact_id) || !boundedText(proposal.text, 1000)) return null;
  if (
    !isRecord(recipient)
    || (recipient.kind === "unavailable" && !exactKeys(recipient, ["kind"]))
    || (recipient.kind === "resolved" && (
      !exactKeys(recipient, ["kind", "handle"])
      || !boundedText(recipient.handle, 320)
    ))
    || !(recipient.kind === "unavailable" || recipient.kind === "resolved")
  ) return null;
  return {
    schema_version: "draft_delivery.v1",
    contact_id: proposal.contact_id,
    text: proposal.text,
    recipient,
  };
}

/** Deterministic seam for recorded fixtures; it does not establish shipping eligibility. */
export class RecordedFollowUpDraftProvider implements FollowUpDraftProvider {
  readonly calls: DraftProviderInput[] = [];

  constructor(private readonly output: unknown) {}

  async generate(input: DraftProviderInput): Promise<unknown> {
    this.calls.push(structuredClone(input));
    return this.output;
  }
}
