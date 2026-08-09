// R2 object-at-rest encryption — reuses the existing envelope-encryption pattern
// from handle-vault.ts and turn-vault.ts (AES-256-GCM, per-object nonce, AAD).
//
// Every R2 object is encrypted with a fresh 96-bit nonce. Without the master key,
// a bucket compromise yields ciphertext. The pattern is the same HandleVaultKeyProvider
// already used for contact handles and turn text; no new key material is introduced.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { HandleVaultKeyProvider } from "../../inbound/handle-vault.js";

const ALGORITHM = "aes-256-gcm" as const;
const PURPOSE = "boi.r2-content.v1";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export type R2CipherContext = {
  user_id: string;
  /** The object key, e.g. "users/usr_.../digests/dig_....json" */
  object_key: string;
};

/** JSON-safe encryption envelope. Every binary member is base64url. */
export type EncryptedR2Envelope = {
  algorithm: typeof ALGORITHM;
  key_version: string;
  nonce: string;      // 12 bytes → 16 base64url chars
  ciphertext: string; // variable
  auth_tag: string;   // 16 bytes → 22 base64url chars
};

export type R2CipherOptions = {
  keyProvider: HandleVaultKeyProvider;
  randomBytes?: (size: number) => Buffer;
};

export class R2CipherError extends Error {
  constructor(
    readonly code: "encryption_failed" | "decryption_failed" | "key_unavailable",
  ) {
    super(`r2_cipher_${code}`);
  }
}

/**
 * Encrypts content before it reaches R2. The envelope carries a key version
 * rather than a key — platform wiring maps that version to the master secret.
 */
export class R2Cipher {
  constructor(private readonly options: R2CipherOptions) {}

  async seal(
    context: R2CipherContext,
    plaintext: Buffer,
  ): Promise<EncryptedR2Envelope> {
    try {
      assertContext(context);
      const key = await this.options.keyProvider.active();
      assertKey(key.key, key.key_version);
      const nonce = this.random(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, key.key, nonce);
      cipher.setAAD(aad(context, key.key_version));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        algorithm: ALGORITHM,
        key_version: key.key_version,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        auth_tag: cipher.getAuthTag().toString("base64url"),
      };
    } catch {
      throw new R2CipherError("encryption_failed");
    }
  }

  async open(
    context: R2CipherContext,
    envelope: EncryptedR2Envelope,
  ): Promise<Buffer> {
    try {
      assertContext(context);
      assertEnvelope(envelope);
      const key = await this.options.keyProvider.byVersion(envelope.key_version);
      if (key === null) throw new R2CipherError("key_unavailable");
      assertKey(key.key, key.key_version);
      const decipher = createDecipheriv(
        ALGORITHM,
        key.key,
        Buffer.from(envelope.nonce, "base64url"),
      );
      decipher.setAAD(aad(context, envelope.key_version));
      decipher.setAuthTag(Buffer.from(envelope.auth_tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
    } catch (err) {
      if (err instanceof R2CipherError) throw err;
      throw new R2CipherError("decryption_failed");
    }
  }

  private random(size: number): Buffer {
    return this.options.randomBytes?.(size) ?? randomBytes(size);
  }
}

function aad(context: R2CipherContext, keyVersion: string): Buffer {
  return Buffer.from(
    JSON.stringify([PURPOSE, ALGORITHM, keyVersion, context.user_id, context.object_key]),
    "utf8",
  );
}

function assertContext(context: R2CipherContext): void {
  if (context.user_id.length === 0 || context.object_key.length === 0) {
    throw new Error("invalid cipher context");
  }
}

function assertKey(key: Buffer, version: string): void {
  if (key.length !== KEY_BYTES || version.length === 0) {
    throw new Error("invalid cipher key");
  }
}

function assertEnvelope(envelope: EncryptedR2Envelope): void {
  if (
    envelope.algorithm !== ALGORITHM ||
    envelope.key_version.length === 0 ||
    envelope.ciphertext.length === 0
  ) throw new Error("invalid envelope");
  const nonce = Buffer.from(envelope.nonce, "base64url");
  const tag = Buffer.from(envelope.auth_tag, "base64url");
  if (nonce.length !== NONCE_BYTES || tag.length !== 16) {
    throw new Error("invalid envelope");
  }
}