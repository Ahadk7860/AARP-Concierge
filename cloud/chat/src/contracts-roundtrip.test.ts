import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ChatQuery, ChatReply } from "../../shared/src/contracts.js";
import { parseSelectorOutput } from "./selector.js";

const root = process.cwd();

function json(path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as unknown;
}

describe("frozen chat contract round trips", () => {
  it("loads, validates, and round-trips the frozen chat_query fixture", () => {
    const fixture = json("contracts/fixtures/chat_query/waiting_on_me.json") as ChatQuery;
    const schema = json("contracts/schema/chat_query.v1.json") as object;
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

    expect(validate(fixture)).toBe(true);
    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture);
    expect(parseSelectorOutput({ kind: "query", name: fixture.name, limit: fixture.limit })).toEqual({
      kind: "query",
      query: fixture,
    });
  });

  it("loads, validates, and round-trips the frozen chat_reply fixture without normalization", () => {
    const fixture = json("contracts/fixtures/chat_reply/waiting_on_me.json") as ChatReply;
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema(json("contracts/schema/draft_delivery.v1.json") as object);
    const validate = ajv.compile(json("contracts/schema/chat_reply.v1.json") as object);

    expect(validate(fixture)).toBe(true);
    const encoded = JSON.stringify(fixture);
    expect(JSON.parse(encoded)).toEqual(fixture);
    expect((JSON.parse(encoded) as ChatReply).synced_through).toBe("2026-08-01T09:10:00Z");
  });
});
