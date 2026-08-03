// Validates a real response against the frozen OpenAPI document.
//
// Prompt 02: "A response that does not match `contracts/openapi/boi-api.v1.yaml` is a
// bug." That is only checkable if something reads the document, so this does — the
// actual YAML, resolving `$ref`s into `contracts/schema/`, with ajv rather than a
// hand-rolled checker that would be exactly as lenient as my assumptions.
//
// Test-only. Nothing in the request path imports this.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { Ajv2020 } from "ajv/dist/2020.js";

const ROOT = process.cwd();
const SPEC_PATH = join(ROOT, "contracts", "openapi", "boi-api.v1.yaml");

type Json = Record<string, unknown>;

export const spec = loadYaml(readFileSync(SPEC_PATH, "utf8")) as Json;

const ajv = new Ajv2020({ strict: false, allErrors: true });

// The document uses exactly one format. Defining it here rather than pulling in
// ajv-formats keeps the shared-manifest append to one package, and makes the
// definition the same ISO-8601-UTC rule CONTRACTS.md section 6 states — ajv-formats'
// `date-time` would have accepted `+00:00` offsets, which section 6 forbids.
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

/** Resolves `#/components/...` and `../schema/x.json` refs the spec actually uses. */
function resolveRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(resolveRefs);
  if (typeof node !== "object" || node === null) return node;

  const obj = node as Json;
  const ref = obj["$ref"];
  if (typeof ref === "string") {
    if (ref.startsWith("#/")) {
      let target: unknown = spec;
      for (const part of ref.slice(2).split("/")) {
        target = (target as Json)[part];
      }
      return resolveRefs(target);
    }
    if (ref.startsWith("../schema/")) {
      const schema = JSON.parse(
        readFileSync(join(ROOT, "contracts", ref.replace("../", "")), "utf8"),
      ) as Json;
      // `$id`/`$schema` would make ajv try to register the document globally.
      delete schema["$id"];
      delete schema["$schema"];
      return resolveRefs(schema);
    }
    throw new Error(`unsupported $ref: ${ref}`);
  }

  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) out[k] = resolveRefs(v);
  return out;
}

/**
 * The response schema the document declares for one path/method/status, or null when
 * the document declares no body (a `204`, for instance).
 */
export function responseSchema(path: string, method: string, status: number): Json | null {
  const paths = spec["paths"] as Json;
  const entry = paths[path] as Json | undefined;
  if (entry === undefined) throw new Error(`spec has no path ${path}`);
  const op = entry[method.toLowerCase()] as Json | undefined;
  if (op === undefined) throw new Error(`spec has no ${method} ${path}`);

  const responses = resolveRefs(op["responses"]) as Json;
  const response = responses[String(status)] as Json | undefined;
  if (response === undefined) {
    throw new Error(`spec does not document ${method} ${path} -> ${status}`);
  }
  const content = response["content"] as Json | undefined;
  if (content === undefined) return null;
  const json = content["application/json"] as Json | undefined;
  if (json === undefined) return null;
  return (json["schema"] as Json | undefined) ?? null;
}

export type Conformance = { ok: boolean; errors: string[]; documented: boolean };

/**
 * Check one real response body against the document.
 *
 * A status the document does not list is a failure, not a skip — returning an
 * undocumented status is exactly the kind of drift this is here to catch.
 */
export function checkResponse(
  path: string,
  method: string,
  status: number,
  body: unknown,
): Conformance {
  let schema: Json | null;
  try {
    schema = responseSchema(path, method, status);
  } catch (err) {
    return { ok: false, documented: false, errors: [(err as Error).message] };
  }

  if (schema === null) {
    // Documented with no body: anything other than an empty body is drift.
    const empty = body === undefined || body === null || body === "";
    return {
      ok: empty,
      documented: true,
      errors: empty ? [] : [`${status} is documented with no body, got ${JSON.stringify(body)}`],
    };
  }

  const validate = ajv.compile(schema);
  const ok = validate(body) as boolean;
  return {
    ok,
    documented: true,
    errors: (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`),
  };
}
