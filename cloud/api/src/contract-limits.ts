// Limits and patterns read OUT OF the frozen JSON Schemas at load time.
//
// Prompt 02 asks for zod validation "generated from or checked against
// contracts/schema/". This is the generated-from half, and it exists because of a bug
// this track already shipped once: `ids.ts` minted base64url ids while the SQL CHECK
// and the scope regex independently spelled the same constraint more loosely, so three
// places agreed with each other and all three disagreed with the contract. Nothing
// caught it locally.
//
// A hand-copied `.max(40)` is the same defect waiting to happen. Reading the number
// from `voice_pack.v1.json` means the contract cannot drift away from the validator
// without the validator moving with it.
//
// `contracts/**` is frozen and read-only here — this module never writes to it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_DIR = join(process.cwd(), "contracts", "schema");

type JsonSchema = Record<string, unknown>;

function loadSchema(name: string): JsonSchema {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")) as JsonSchema;
}

/** Walks a schema path, failing loudly rather than silently yielding undefined. */
function at(schema: JsonSchema, path: readonly string[], file: string): JsonSchema {
  let node: unknown = schema;
  for (const key of path) {
    if (typeof node !== "object" || node === null || !(key in node)) {
      throw new Error(`${file}: no such path ${path.join(".")}`);
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node as JsonSchema;
}

function num(schema: JsonSchema, key: string, file: string, path: readonly string[]): number {
  const v = schema[key];
  if (typeof v !== "number") {
    throw new Error(`${file}: ${path.join(".")}.${key} is not a number`);
  }
  return v;
}

function str(schema: JsonSchema, key: string, file: string, path: readonly string[]): string {
  const v = schema[key];
  if (typeof v !== "string") {
    throw new Error(`${file}: ${path.join(".")}.${key} is not a string`);
  }
  return v;
}

const voicePack = loadSchema("voice_pack.v1.json");
const digest = loadSchema("digest.v1.json");

const exemplarsPath = ["properties", "exemplars"] as const;
const exemplars = at(voicePack, exemplarsPath, "voice_pack.v1.json");
const exemplarItems = at(exemplars, ["items"], "voice_pack.v1.json");

export const VOICE_PACK_LIMITS = {
  maxExemplars: num(exemplars, "maxItems", "voice_pack.v1.json", exemplarsPath),
  maxExemplarChars: num(exemplarItems, "maxLength", "voice_pack.v1.json", [
    ...exemplarsPath,
    "items",
  ]),
  minExemplarChars: num(exemplarItems, "minLength", "voice_pack.v1.json", [
    ...exemplarsPath,
    "items",
  ]),
  versionPattern: new RegExp(
    str(
      at(voicePack, ["properties", "voice_pack_version"], "voice_pack.v1.json"),
      "pattern",
      "voice_pack.v1.json",
      ["properties", "voice_pack_version"],
    ),
  ),
} as const;

export const ID_PATTERNS = {
  user: new RegExp(
    str(at(digest, ["properties", "user_id"], "digest.v1.json"), "pattern", "digest.v1.json", [
      "properties",
      "user_id",
    ]),
  ),
  device: new RegExp(
    str(at(digest, ["properties", "device_id"], "digest.v1.json"), "pattern", "digest.v1.json", [
      "properties",
      "device_id",
    ]),
  ),
  contact: new RegExp(
    str(
      at(digest, ["$defs", "relationship", "properties", "contact_id"], "digest.v1.json"),
      "pattern",
      "digest.v1.json",
      ["$defs", "relationship", "properties", "contact_id"],
    ),
  ),
} as const;
