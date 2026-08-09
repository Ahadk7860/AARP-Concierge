// Drift guard for the §4.2a frozen intent keys.
//
// `chat_route.v1.json`'s `intent` enum, `cloud/api/src/schemas.ts`'s chatRouteV1Schema,
// and `differential.test.ts`'s cases all hand-copy the same 4 strings — and all three
// agree with EACH OTHER, never against the one place that actually matters:
// `cloud/shared/src/intents.ts` (owned by Track G/DeepSeek, §4.2a). If that file lands
// and someone renames "overdue" to something else, nothing here would fail, and per
// §4.2a's own warning a renamed key is a SILENT PERMANENT CACHE MISS against
// `precomputed_answers.intent` — exactly the failure class this repo's differential
// tests exist to catch for schema drift, just on a cross-package axis instead of a
// zod-vs-JSON-Schema one.
//
// `cloud/shared/src/intents.ts` does not exist in this worktree as of this test's
// authorship (Track A does not create it — Track G/DeepSeek owns that file). This test
// skips cleanly until it lands, then bites the moment it does.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const INTENTS_FILE = join(process.cwd(), "cloud", "shared", "src", "intents.ts");
const CHAT_ROUTE_SCHEMA = join(process.cwd(), "contracts", "schema", "chat_route.v1.json");

describe("cloud/shared/src/intents.ts vs. chat_route.v1.json's intent enum", () => {
  it.skipIf(!existsSync(INTENTS_FILE))(
    "INTENTS is set-equal to the frozen schema's intent enum — a renamed/added/removed key here must fail this test",
    async () => {
      // Built at runtime (not a string literal in the import() call) so `tsc --noEmit`
      // does not try to statically resolve this module's types — it does not exist in
      // this worktree, and a literal `import("../../shared/src/intents.js")` would make
      // typecheck fail unconditionally, defeating the whole point of skipping cleanly.
      const specifier = ["..", "..", "shared", "src", "intents.js"].join("/");
      const mod = (await import(specifier)) as { INTENTS: readonly string[] };
      const schema = JSON.parse(readFileSync(CHAT_ROUTE_SCHEMA, "utf8")) as {
        properties: { intent: { enum: string[] } };
      };
      expect(new Set(mod.INTENTS)).toEqual(new Set(schema.properties.intent.enum));
    },
  );

  it("this guard itself is not vacuous — fails loudly if the schema enum and a wrong set disagree", () => {
    const schema = JSON.parse(readFileSync(CHAT_ROUTE_SCHEMA, "utf8")) as {
      properties: { intent: { enum: string[] } };
    };
    const wrong = new Set([...schema.properties.intent.enum, "not_a_real_intent"]);
    expect(new Set(schema.properties.intent.enum)).not.toEqual(wrong);
  });
});
