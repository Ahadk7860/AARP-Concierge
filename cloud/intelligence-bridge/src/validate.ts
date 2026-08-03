// Boundary validation, against the frozen JSON Schemas rather than a TypeScript type.
//
// CONTRACTS.md § 1: "The canonical definitions are the JSON Schemas in
// `contracts/schema/`. They are the arbiter when a language mirror disagrees." A
// TypeScript `Gist` is a compile-time claim about a shape Python produced at runtime,
// and this bridge exists precisely because those two have never met. So the check is
// the schema itself.
//
// **A malformed gist is a dropped gist, not a thrown brief.** One bad document out of
// three must not cost the user their morning text.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { REPO_ROOT } from "./invoke.js";

const ajv = new Ajv2020({ strict: false, allErrors: true });

// CONTRACTS.md § 6: ISO 8601 UTC with a `Z`. ajv-formats' `date-time` accepts an
// offset, which is exactly the drift the convention exists to prevent.
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

const compiled = new Map<string, ValidateFunction>();

export function validatorFor(schemaName: string): ValidateFunction {
  const existing = compiled.get(schemaName);
  if (existing !== undefined) return existing;
  const file = path.join(REPO_ROOT, "contracts", "schema", `${schemaName}.json`);
  const validate = ajv.compile(JSON.parse(readFileSync(file, "utf8")) as object);
  compiled.set(schemaName, validate);
  return validate;
}

export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string };

/**
 * Field paths and messages; **never values**.
 *
 * A validation error on a gist must not echo the gist back into a log — the gist is the
 * abstraction that crossed the digest boundary, and putting it in an observability
 * vendor is the thing the boundary exists to prevent.
 */
export function check<T>(schemaName: string, document: unknown): Validation<T> {
  const validate = validatorFor(schemaName);
  if (validate(document)) return { ok: true, value: document as T };
  const errors = (validate.errors ?? [])
    .slice(0, 5)
    .map((e) => `${e.instancePath || "(root)"}: ${e.message ?? "invalid"}`)
    .join("; ");
  return { ok: false, errors };
}
