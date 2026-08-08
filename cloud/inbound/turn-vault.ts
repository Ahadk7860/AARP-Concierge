import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { HandleVaultKeyProvider } from "./handle-vault.js";

const ALGORITHM = "aes-256-gcm" as const;
const PURPOSE = "boi.user-boi-turn.v1";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export type TurnDirection = "inbound" | "outbound";
export type TurnVaultContext = {
  user_id: string;
  turn_id: string;
  direction: TurnDirection;
};

export type EncryptedTurnPayload = {
  algorithm: typeof ALGORITHM;
  key_version: string;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
};

export class TurnVaultError extends Error {
  constructor(readonly code: "encryption_failed" | "decryption_failed") {
    super(`turn_${code}`);
  }
}

export type TurnVaultOptions = {
  keyProvider: HandleVaultKeyProvider;
  randomBytes?: (size: number) => Buffer;
};

/** Encrypts only user↔Boi turn text; counterpart conversation prose never enters it. */
export class TurnVault {
  constructor(private readonly options: TurnVaultOptions) {}

  async seal(context: TurnVaultContext, text: string): Promise<EncryptedTurnPayload> {
    try {
      assertContext(context);
      const key = await this.options.keyProvider.active();
      assertKey(key.key_version, key.key);
      const nonce = this.options.randomBytes?.(NONCE_BYTES) ?? randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, key.key, nonce);
      cipher.setAAD(aad(context, key.key_version));
      const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return {
        algorithm: ALGORITHM,
        key_version: key.key_version,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        auth_tag: cipher.getAuthTag().toString("base64url"),
      };
    } catch {
      throw new TurnVaultError("encryption_failed");
    }
  }

  async open(context: TurnVaultContext, encrypted: EncryptedTurnPayload): Promise<string> {
    try {
      assertContext(context);
      assertEnvelope(encrypted);
      const key = await this.options.keyProvider.byVersion(encrypted.key_version);
      if (key === null || key.key_version !== encrypted.key_version) throw new Error("key unavailable");
      assertKey(key.key_version, key.key);
      const decipher = createDecipheriv(ALGORITHM, key.key, Buffer.from(encrypted.nonce, "base64url"));
      decipher.setAAD(aad(context, encrypted.key_version));
      decipher.setAuthTag(Buffer.from(encrypted.auth_tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new TurnVaultError("decryption_failed");
    }
  }
}

function aad(context: TurnVaultContext, keyVersion: string): Buffer {
  return Buffer.from(JSON.stringify([
    PURPOSE,
    ALGORITHM,
    keyVersion,
    context.user_id,
    context.direction,
    context.turn_id,
  ]), "utf8");
}

function assertContext(context: TurnVaultContext): void {
  if (context.user_id.length === 0 || context.turn_id.length === 0 ||
      (context.direction !== "inbound" && context.direction !== "outbound")) {
    throw new Error("invalid turn context");
  }
}

function assertKey(version: string, key: Buffer): void {
  if (version.length === 0 || key.length !== KEY_BYTES) throw new Error("invalid turn key");
}

function assertEnvelope(encrypted: EncryptedTurnPayload): void {
  if (encrypted.algorithm !== ALGORITHM || encrypted.key_version.length === 0 || encrypted.ciphertext.length === 0 ||
      Buffer.from(encrypted.nonce, "base64url").length !== NONCE_BYTES ||
      Buffer.from(encrypted.auth_tag, "base64url").length !== 16) {
    throw new Error("invalid turn envelope");
  }
}
