import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = process.cwd();
const schemas = join(root, "contracts/schema");
const fixture = (dir: string, name: string) =>
  JSON.parse(readFileSync(join(root, "contracts/fixtures", dir, name), "utf8")) as Record<string, unknown>;

function validate(name: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  for (const dependency of ["digest.v1.json", "voice_pack.v1.json", "draft_delivery.v1.json"]) {
    if (dependency === name) continue;
    ajv.addSchema(JSON.parse(readFileSync(join(schemas, dependency), "utf8")) as object);
  }
  return ajv.compile(JSON.parse(readFileSync(join(schemas, name), "utf8")) as object);
}

describe("Phase 2 frozen schemas", () => {
  it("accepts the machine-readable producer/consumer fixtures", () => {
    for (const [schema, dir, name] of [
      ["digest.v2.json", "digest_v2", "understood.json"],
      ["voice_pack.v2.json", "voice_pack_v2", "maya.json"],
      ["chat_query.v1.json", "chat_query", "waiting_on_me.json"],
      ["chat_reply.v1.json", "chat_reply", "waiting_on_me.json"],
      ["draft_delivery.v1.json", "draft_delivery", "unavailable.json"],
    ] as const) expect(validate(schema)(fixture(dir, name)), schema).toBe(true);
  });

  it("does not widen the first-release chat capability", () => {
    const query = fixture("chat_query", "waiting_on_me.json");
    query["name"] = "longest_silent";
    expect(validate("chat_query.v1.json")(query)).toBe(false);
  });

  it("makes missing handles an explicit degraded path", () => {
    const delivery = fixture("draft_delivery", "unavailable.json");
    delivery["recipient"] = {};
    expect(validate("draft_delivery.v1.json")(delivery)).toBe(false);
  });
});
