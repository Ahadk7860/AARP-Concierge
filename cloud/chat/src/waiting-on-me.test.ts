import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DigestV2 } from "../../shared/src/contracts.js";
import { executeWaitingOnMe } from "./waiting-on-me.js";

const root = process.cwd();

function digestFixture(): DigestV2 {
  return JSON.parse(
    readFileSync(join(root, "contracts/fixtures/digest_v2/understood.json"), "utf8"),
  ) as DigestV2;
}

function relationship(overrides: Partial<DigestV2["relationships"][number]> = {}): DigestV2["relationships"][number] {
  const source = digestFixture().relationships[0];
  if (source === undefined) throw new Error("missing understood fixture relationship");
  return {
    ...source,
    ...overrides,
    understanding: { ...source.understanding, ...overrides.understanding },
  };
}

describe("waiting_on_me closed query", () => {
  it("returns only evidence for questions from them with a real open thread and carries the sync horizon", () => {
    const digest = digestFixture();
    digest.relationships.push(
      relationship({
        contact_id: "h_00000001",
        display: "Excluded statement",
        understanding: { ...relationship().understanding, last_exchange_shape: "statement_from_them" },
      }),
      relationship({
        contact_id: "h_00000002",
        display: "Excluded closed thread",
        understanding: { ...relationship().understanding, open_thread: null },
      }),
    );

    const result = executeWaitingOnMe(digest, { schema_version: "chat_query.v1", name: "waiting_on_me", limit: 3 });

    expect(result).toEqual({
      name: "waiting_on_me",
      synced_through: "2026-08-01T09:10:00Z",
      rows: [{
        contact_id: "h_8f21a4c0",
        display: "Maya",
        open_thread: "asked whether you are coming, unanswered",
      }],
    });
  });

  it("ranks deterministically and honors the frozen limit range from 1 through 5", () => {
    const digest = digestFixture();
    digest.relationships.push(
      relationship({ contact_id: "h_00000002", display: "Nora", days_since_last_contact: 8 }),
      relationship({ contact_id: "h_00000001", display: "Ari", days_since_last_contact: 8 }),
      relationship({ contact_id: "h_00000003", display: "Zoe", days_since_last_contact: 4 }),
      relationship({ contact_id: "h_00000004", display: "Sam", days_since_last_contact: 3 }),
    );

    expect(executeWaitingOnMe(digest, { schema_version: "chat_query.v1", name: "waiting_on_me", limit: 5 }).rows.map((row) => row.contact_id))
      .toEqual(["h_00000001", "h_00000002", "h_00000003", "h_00000004", "h_8f21a4c0"]);
    expect(executeWaitingOnMe(digest, { schema_version: "chat_query.v1", name: "waiting_on_me", limit: 1 }).rows)
      .toHaveLength(1);
  });

  it("does not let a mutation in one relationship alter another row or expose its private fields", () => {
    const digest = digestFixture();
    const other = relationship({
      contact_id: "h_00000009",
      display: "Nora",
      days_since_last_contact: 1,
      understanding: {
        ...relationship().understanding,
        open_thread: "separate derived thread",
        voice_exemplars: [{ text: "PRIVATE_USER_VOICE", answered: "question_from_them", register: "warm" }],
      },
    });
    digest.relationships.push(other);

    const before = executeWaitingOnMe(digest, { schema_version: "chat_query.v1", name: "waiting_on_me", limit: 3 });
    other.understanding.open_thread = "MUTATED_OTHER_CONTACT_ONLY";
    other.understanding.voice_exemplars[0]!.text = "RAW_HANDLE_15551234567";
    const after = executeWaitingOnMe(digest, { schema_version: "chat_query.v1", name: "waiting_on_me", limit: 3 });

    expect(after.rows.find((row) => row.contact_id === "h_8f21a4c0"))
      .toEqual(before.rows.find((row) => row.contact_id === "h_8f21a4c0"));
    expect(JSON.stringify(after)).not.toContain("RAW_HANDLE_15551234567");
    expect(Object.keys(after.rows[0] ?? {}).sort()).toEqual(["contact_id", "display", "open_thread"]);
  });

  it("excludes a group even when every other waiting_on_me field qualifies", () => {
    const digest = digestFixture();
    digest.relationships[0]!.is_group = true;

    const result = executeWaitingOnMe(digest, {
      schema_version: "chat_query.v1",
      name: "waiting_on_me",
      limit: 3,
    });

    expect(result.rows).toEqual([]);
  });

  it("refuses a capability outside the frozen first-release vocabulary", () => {
    expect(() => executeWaitingOnMe(digestFixture(), {
      schema_version: "chat_query.v1",
      name: "longest_silent",
    } as never)).toThrow("unsupported chat query");
  });
});
