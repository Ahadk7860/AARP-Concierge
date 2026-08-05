import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const PURPOSE = "boi.contact-handle.v1";

/** A key is supplied by platform wiring; no key material is ever read from the database. */
export type HandleVaultKey = {
  key_version: string;
  key: Buffer;
};

/** Platform-owned envelope/key service, supplied by Track H at composition time. */
export interface HandleVaultKeyProvider {
  active(): Promise<HandleVaultKey>;
  byVersion(keyVersion: string): Promise<HandleVaultKey | null>;
}

/** A JSON-safe storage envelope. Every binary member is base64url, never plaintext. */
export type EncryptedHandle = {
  algorithm: typeof ALGORITHM;
  key_version: string;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
};

export type HandleVaultContext = {
  user_id: string;
  contact_id: string;
};

export class HandleVaultError extends Error {
  constructor(readonly code: "encryption_failed" | "decryption_failed") {
    // Do not chain provider/crypto errors: providers can include request metadata, and
    // callers commonly log Error.message. A handle must never reach a loggable error.
    super(`handle_${code}`);
  }
}

export type HandleVaultOptions = {
  keyProvider: HandleVaultKeyProvider;
  /** Injectable solely to make nonce uniqueness/mutation tests deterministic. */
  randomBytes?: (size: number) => Buffer;
};

/**
 * Encrypts the sensitive contact-handle leaf before it reaches any storage boundary.
 *
 * The encrypted object deliberately carries a key version rather than a key envelope:
 * platform wiring decides how that version maps to its master-secret-backed material.
 * The same plaintext sealed twice has different ciphertext because every seal uses a
 * fresh 96-bit nonce.
 */
export class HandleVault {
  constructor(private readonly options: HandleVaultOptions) {}

  async seal(context: HandleVaultContext, handle: string): Promise<EncryptedHandle> {
    try {
      assertContext(context);
      const key = await this.options.keyProvider.active();
      assertKey(key);
      const nonce = this.random(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, key.key, nonce);
      cipher.setAAD(aad(context, key.key_version));
      const ciphertext = Buffer.concat([cipher.update(handle, "utf8"), cipher.final()]);
      return {
        algorithm: ALGORITHM,
        key_version: key.key_version,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        auth_tag: cipher.getAuthTag().toString("base64url"),
      };
    } catch {
      throw new HandleVaultError("encryption_failed");
    }
  }

  async open(context: HandleVaultContext, envelope: EncryptedHandle): Promise<string> {
    try {
      assertContext(context);
      assertEnvelope(envelope);
      const key = await this.options.keyProvider.byVersion(envelope.key_version);
      if (key === null) throw new Error("unknown key version");
      assertKey(key);
      if (key.key_version !== envelope.key_version) throw new Error("key version mismatch");
      const decipher = createDecipheriv(ALGORITHM, key.key, Buffer.from(envelope.nonce, "base64url"));
      decipher.setAAD(aad(context, envelope.key_version));
      decipher.setAuthTag(Buffer.from(envelope.auth_tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new HandleVaultError("decryption_failed");
    }
  }

  private random(size: number): Buffer {
    return this.options.randomBytes?.(size) ?? randomBytes(size);
  }
}

function aad(context: HandleVaultContext, keyVersion: string): Buffer {
  // Length-prefixing through JSON's string representation prevents ambiguous joins.
  return Buffer.from(JSON.stringify([PURPOSE, ALGORITHM, keyVersion, context.user_id, context.contact_id]), "utf8");
}

function assertContext(context: HandleVaultContext): void {
  if (context.user_id.length === 0 || context.contact_id.length === 0) throw new Error("invalid vault context");
}

function assertKey(key: HandleVaultKey): void {
  if (key.key.length !== KEY_BYTES || key.key_version.length === 0) throw new Error("invalid vault key");
}

function assertEnvelope(envelope: EncryptedHandle): void {
  if (envelope.algorithm !== ALGORITHM || envelope.key_version.length === 0) throw new Error("invalid envelope");
  const nonce = Buffer.from(envelope.nonce, "base64url");
  const tag = Buffer.from(envelope.auth_tag, "base64url");
  if (nonce.length !== NONCE_BYTES || tag.length !== 16 || envelope.ciphertext.length === 0) {
    throw new Error("invalid envelope");
  }
}
