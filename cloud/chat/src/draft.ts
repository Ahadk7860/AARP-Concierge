import type { DraftDelivery } from "../../shared/src/contracts.js";

const CONTACT_ID = /^h_[0-9a-f]{8,32}$/;
const VOICE_PACK_VERSION = /^vp_[0-9a-f]{8,16}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const FACT_CATEGORIES = ["dates", "times", "places", "amounts", "names"] as const;
const REGISTER = ["casual", "warm", "terse", "formal", "mixed"] as const;
const SHAPE = ["question_from_them", "statement_from_them", "statement_from_you", "plan_unresolved", "none"] as const;
const ANSWERED = ["question_from_them", "statement_from_them", "plan_unresolved", "none"] as const;
const RELATIONSHIP_KIND = ["close_friend", "logistics", "work", "family", "dormant_close", "other"] as const;
const PUNCTUATION = ["lowercase_no_period", "lowercase_period", "sentence_case_no_period", "sentence_case_period", "mixed"] as const;
const TEMPLATE_IDS = ["acknowledge_open_thread", "defer_open_thread"] as const;

type FactCategory = typeof FACT_CATEGORIES[number];
type Register = typeof REGISTER[number];
type ExchangeShape = typeof SHAPE[number];
type Answered = typeof ANSWERED[number];
type Punctuation = typeof PUNCTUATION[number];
type TemplateId = typeof TEMPLATE_IDS[number];

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

/**
 * A provider may select one closed intent and license it to the exact derived open
 * thread. It cannot write prose. Track J owns the only strings that can be delivered.
 */
export type DraftProviderOutput = {
  template_id: TemplateId;
  claim: { source: "open_thread"; value: string };
};

export interface FollowUpDraftProvider {
  generate(input: DraftProviderInput): Promise<unknown>;
}

/** The successful handoff deliberately contains no display name, handle, or send action. */
export type DraftProposal = { readonly contact_id: string; readonly text: string };

// Runtime provenance is deliberately non-serializable. A caller cannot construct an
// arbitrary `{contact_id,text}` and feed it to delivery; composition accepts only the
// exact object returned after the closed-template gate above. The frozen wire object is
// `DraftDelivery`, not this in-process capability.
const LICENSED_PROPOSALS = new WeakSet<object>();

export type DraftProposalOutcome =
  | { kind: "proposal"; proposal: DraftProposal }
  | { kind: "decline"; reason: "invalid_input" | "provider_failure" | "unlicensed_output" };

/** Track I must bind its resolution to the same pseudonymous contact before handoff. */
export type RecipientResolution = {
  contact_id: string;
  recipient: DraftDelivery["recipient"];
};

type VoiceRegister = {
  median_len_chars: number;
  p90_len_chars?: number;
  emoji_rate: number;
  punctuation: Punctuation;
  avg_msgs_per_burst: number;
};

type DraftSource = {
  contactId: string;
  providerInput: DraftProviderInput;
  register: VoiceRegister;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function exactOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isEnum<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

/** Reject lone UTF-16 surrogates before text reaches an sms: URL or clipboard path. */
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string"
    && isWellFormedUnicode(value)
    && value.trim().length > 0
    && value.length <= max;
}

function validUtcDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) return false;
  const match = ISO_UTC.exec(value);
  if (match === null) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return (match[1] === undefined ? parsed.toISOString().replace(".000Z", "Z") : parsed.toISOString()) === value;
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

function rate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function stringArray(value: unknown, maxItems: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => typeof item === "string" && isWellFormedUnicode(item));
}

function parseRegister(value: unknown): VoiceRegister | null {
  if (!isRecord(value)) return null;
  if (!exactOptionalKeys(
    value,
    ["median_len_chars", "emoji_rate", "punctuation", "avg_msgs_per_burst"],
    ["p90_len_chars", "top_emoji", "greeting_rate", "signoff_rate", "abbreviations", "question_rate", "apology_openers"],
  )) return null;
  if (
    !Number.isInteger(value.median_len_chars) || (value.median_len_chars as number) < 1
    || !(value.p90_len_chars === undefined || (Number.isInteger(value.p90_len_chars) && (value.p90_len_chars as number) >= 1))
    || !rate(value.emoji_rate)
    || !isEnum(value.punctuation, PUNCTUATION)
    || typeof value.avg_msgs_per_burst !== "number"
    || !Number.isFinite(value.avg_msgs_per_burst)
    || value.avg_msgs_per_burst < 1
    || !(value.top_emoji === undefined || stringArray(value.top_emoji, 5))
    || !(value.greeting_rate === undefined || rate(value.greeting_rate))
    || !(value.signoff_rate === undefined || rate(value.signoff_rate))
    || !(value.abbreviations === undefined || stringArray(value.abbreviations, 20))
    || !(value.question_rate === undefined || rate(value.question_rate))
    || !(value.apology_openers === undefined || stringArray(value.apology_openers, 5))
  ) return null;
  return {
    median_len_chars: value.median_len_chars as number,
    p90_len_chars: value.p90_len_chars as number | undefined,
    emoji_rate: value.emoji_rate,
    punctuation: value.punctuation,
    avg_msgs_per_burst: value.avg_msgs_per_burst,
  };
}

function parseVoicePack(value: unknown, contactId: string): {
  exemplars: DraftProviderInput["voice_exemplars"];
  register: VoiceRegister;
} | null {
  if (!isRecord(value)) return null;
  if (!exactOptionalKeys(
    value,
    ["schema_version", "voice_pack_version", "contact_id", "scope", "register", "exemplars", "as_of"],
    ["n_exemplars"],
  )) return null;
  if (
    value.schema_version !== "voice_pack.v2"
    || typeof value.voice_pack_version !== "string"
    || !VOICE_PACK_VERSION.test(value.voice_pack_version)
    || value.scope !== "contact"
    || value.contact_id !== contactId
    || !validUtcDateTime(value.as_of)
    || !Array.isArray(value.exemplars)
    || value.exemplars.length === 0
    || value.exemplars.length > 40
    || !(value.n_exemplars === undefined || (
      Number.isInteger(value.n_exemplars)
      && (value.n_exemplars as number) >= 0
      && (value.n_exemplars as number) <= 40
      && value.n_exemplars === value.exemplars.length
    ))
  ) return null;
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
  if (!isRecord(value) || !exactKeys(value, ["template_id", "claim"]) || !isEnum(value.template_id, TEMPLATE_IDS)) return null;
  if (
    !isRecord(value.claim)
    || !exactKeys(value.claim, ["source", "value"])
    || value.claim.source !== "open_thread"
    || typeof value.claim.value !== "string"
  ) return null;
  return { template_id: value.template_id, claim: { source: "open_thread", value: value.claim.value } };
}

function renderTemplate(templateId: TemplateId, punctuation: Punctuation): string {
  const lower = punctuation.startsWith("lowercase");
  if (templateId === "defer_open_thread") {
    return lower
      ? "sorry i missed this, can i get back to you soon?"
      : "Sorry I missed this, can I get back to you soon?";
  }
  return lower
    ? "sorry i missed this, can you remind me?"
    : "Sorry I missed this, could you remind me?";
}

function lengthLimit(register: VoiceRegister): number {
  const p90 = register.p90_len_chars ?? register.median_len_chars;
  return Math.max(register.median_len_chars * register.avg_msgs_per_burst, p90) + 30;
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
    // The provider receives a disposable copy. The pre-call license remains immutable.
    value = await provider.generate(structuredClone(source.providerInput));
  } catch {
    return { kind: "decline", reason: "provider_failure" };
  }
  const output = parseProviderOutput(value);
  if (output === null || output.claim.value !== source.providerInput.understanding.open_thread) {
    return { kind: "decline", reason: "unlicensed_output" };
  }

  // Provider prose has no path to the result: only this closed Track-J template ships.
  const text = renderTemplate(output.template_id, source.register.punctuation);
  if (!boundedText(text, 1000) || text.length > lengthLimit(source.register)) {
    return { kind: "decline", reason: "unlicensed_output" };
  }
  const proposal: DraftProposal = Object.freeze({ contact_id: source.contactId, text });
  LICENSED_PROPOSALS.add(proposal);
  return { kind: "proposal", proposal };
}

export function composeDraftDelivery(
  proposal: DraftProposal,
  resolution: RecipientResolution,
): DraftDelivery | null {
  if (
    !LICENSED_PROPOSALS.has(proposal)
    ||
    !CONTACT_ID.test(proposal.contact_id)
    || !boundedText(proposal.text, 1000)
    || !isRecord(resolution)
    || !exactKeys(resolution, ["contact_id", "recipient"])
    || resolution.contact_id !== proposal.contact_id
    || !CONTACT_ID.test(resolution.contact_id)
  ) return null;
  const recipient = resolution.recipient;
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
