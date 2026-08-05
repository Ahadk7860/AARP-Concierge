import type { EncryptedContactHandle, EncryptedTurn, Phase2PrivateRepository } from "../db/src/repository.js";
import type { UserScope } from "../db/src/scope.js";
import type { EncryptedOutboxState } from "../db/src/encrypted.js";
import { HandleVault, type EncryptedHandle } from "./handle-vault.js";
import { TurnVault, type EncryptedTurnPayload, type TurnDirection } from "./turn-vault.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

type ExchangeRepository = Phase2PrivateRepository & {
  encryptedOutcomeFor(scope: UserScope, eventKey: string): Promise<EncryptedOutboxState | null>;
  claimEncryptedOutcome(
    scope: UserScope,
    input: { event_key: string; delivery_key: string; inbound: EncryptedTurn; outbound: EncryptedTurn | null },
  ): Promise<{ claimed: boolean; state: EncryptedOutboxState }>;
  markEncryptedOutcomeDelivered(scope: UserScope, eventKey: string, deliveryKey: string): Promise<void>;
};

export type CanonicalPrivateOutcome = {
  event_key: string;
  delivery_key: string;
  delivery_status: EncryptedOutboxState["delivery_status"];
  outbound_text: string | null;
};

export class PrivateKeyCapabilityUnavailableError extends Error {
  constructor() { super("private_key_capability_unavailable"); }
}

/** Plaintext exists only inside this composition boundary and is encrypted before I/O. */
export class EncryptedPrivateStore {
  constructor(
    private readonly repository: ExchangeRepository,
    private readonly turnVault: TurnVault,
    private readonly handleVault: HandleVault | null,
  ) {}

  async putContactHandle(scope: UserScope, contactId: string, handle: string): Promise<void> {
    if (this.handleVault === null) throw new PrivateKeyCapabilityUnavailableError();
    const sealed = await this.handleVault.seal({ user_id: scope.user_id, contact_id: contactId }, handle);
    await this.repository.putEncryptedContactHandle(scope, storedHandle(contactId, sealed));
  }

  async contactHandleFor(scope: UserScope, contactId: string): Promise<string | null> {
    if (this.handleVault === null) throw new PrivateKeyCapabilityUnavailableError();
    const stored = await this.repository.encryptedContactHandleFor(scope, contactId);
    if (stored === null) return null;
    const envelope = decodeEnvelope(stored.key_envelope, stored.ciphertext);
    return this.handleVault.open({ user_id: scope.user_id, contact_id: contactId }, envelope);
  }

  async canonicalOutcomeFor(scope: UserScope, eventKey: string): Promise<CanonicalPrivateOutcome | null> {
    const state = await this.repository.encryptedOutcomeFor(scope, eventKey);
    return state === null ? null : this.openOutcome(scope, state);
  }

  async claimCanonicalOutcome(input: {
    scope: UserScope;
    event_key: string;
    delivery_key: string;
    inbound: { turn_id: string; text: string; occurred_at: Date };
    outbound: { turn_id: string; text: string; occurred_at: Date } | null;
  }): Promise<{ claimed: boolean; outcome: CanonicalPrivateOutcome }> {
    const inbound = await this.encryptedTurn(input.scope, "inbound", input.inbound);
    const outbound = input.outbound === null
      ? null
      : await this.encryptedTurn(input.scope, "outbound", input.outbound);
    const result = await this.repository.claimEncryptedOutcome(input.scope, {
      event_key: input.event_key,
      delivery_key: input.delivery_key,
      inbound,
      outbound,
    });
    return { claimed: result.claimed, outcome: await this.openOutcome(input.scope, result.state) };
  }

  async markOutcomeDelivered(scope: UserScope, eventKey: string, deliveryKey: string): Promise<void> {
    await this.repository.markEncryptedOutcomeDelivered(scope, eventKey, deliveryKey);
  }

  private async encryptedTurn(
    scope: UserScope,
    direction: TurnDirection,
    turn: { turn_id: string; text: string; occurred_at: Date },
  ): Promise<EncryptedTurn> {
    if (!Number.isFinite(turn.occurred_at.getTime())) throw new Error("private_turn_date_invalid");
    const encrypted = await this.turnVault.seal({ user_id: scope.user_id, turn_id: turn.turn_id, direction }, turn.text);
    return {
      turn_id: turn.turn_id,
      direction,
      ciphertext: Buffer.from(encrypted.ciphertext, "base64url"),
      key_envelope: encodeEnvelope(encrypted),
      occurred_at: turn.occurred_at,
      expires_at: new Date(turn.occurred_at.getTime() + RETENTION_MS),
    };
  }

  private async openOutcome(scope: UserScope, state: EncryptedOutboxState): Promise<CanonicalPrivateOutcome> {
    const outbound_text = state.delivery_status !== "pending" || state.outbound === null
      ? null
      : await this.turnVault.open(
        { user_id: scope.user_id, turn_id: state.outbound.turn_id, direction: "outbound" },
        decodeTurnEnvelope(state.outbound.key_envelope, state.outbound.ciphertext),
      );
    return {
      event_key: state.event_key,
      delivery_key: state.delivery_key,
      delivery_status: state.delivery_status,
      outbound_text,
    };
  }
}

function storedHandle(contactId: string, encrypted: EncryptedHandle): EncryptedContactHandle {
  return {
    contact_id: contactId,
    ciphertext: Buffer.from(encrypted.ciphertext, "base64url"),
    key_envelope: encodeEnvelope(encrypted),
    algorithm: encrypted.algorithm,
  };
}

type CryptoEnvelope = Omit<EncryptedTurnPayload, "ciphertext">;

function encodeEnvelope(encrypted: EncryptedHandle | EncryptedTurnPayload): Buffer {
  const envelope: CryptoEnvelope = {
    algorithm: encrypted.algorithm,
    key_version: encrypted.key_version,
    nonce: encrypted.nonce,
    auth_tag: encrypted.auth_tag,
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

function decodeEnvelope(keyEnvelope: Buffer, ciphertext: Buffer): EncryptedHandle {
  try {
    const parsed = JSON.parse(keyEnvelope.toString("utf8")) as Partial<CryptoEnvelope>;
    if (parsed.algorithm !== "aes-256-gcm" || typeof parsed.key_version !== "string" ||
        typeof parsed.nonce !== "string" || typeof parsed.auth_tag !== "string") {
      throw new Error("invalid envelope");
    }
    return {
      algorithm: parsed.algorithm,
      key_version: parsed.key_version,
      nonce: parsed.nonce,
      auth_tag: parsed.auth_tag,
      ciphertext: ciphertext.toString("base64url"),
    };
  } catch {
    throw new Error("private_envelope_invalid");
  }
}

function decodeTurnEnvelope(keyEnvelope: Buffer, ciphertext: Buffer): EncryptedTurnPayload {
  const handleEnvelope = decodeEnvelope(keyEnvelope, ciphertext);
  return handleEnvelope;
}
