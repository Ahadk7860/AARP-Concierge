// Multi-row batch inserts in repository-v3.ts build their own SQL placeholder lists.
// Every one of them had `base = params.length` where SQL is 1-based, so `$1` was reused
// for both `user_id` and the first row column and the bind count came up short. The same
// bug was fixed once in repository.ts's upsertRelationships and left in four places here.
//
// It survived because nothing ever called these with MORE THAN ONE ROW. A single row
// happens to paper over an off-by-one in the base index. That is the whole test.
import { describe, it, expect, afterAll } from "vitest";
import { migrate } from "./migrate.js";
import { createUser } from "./repository.js";
import { upsertPerson, insertInteractions, upsertOpenLoops } from "./repository-v3.js";
import { closePool } from "./pool.js";

describe("repository-v3 batch inserts accept more than one row", () => {
  afterAll(async () => { await closePool(); });

  it("inserts two interactions in one statement", async () => {
    await migrate();
    const { scope } = await createUser({ phone_e164: "+1555" + String(Date.now()).slice(-7) });
    await upsertPerson(scope, { person_id: "p_a", display: "A" });
    await upsertPerson(scope, { person_id: "p_b", display: "B" });
    const n = await insertInteractions(scope, [
      { interaction_id: "i_1", person_id: "p_a", source: "imessage", direction: "from_me", occurred_at: new Date(), length: 5, meta: {} },
      { interaction_id: "i_2", person_id: "p_b", source: "imessage", direction: "to_me", occurred_at: new Date(), length: 7, meta: {} },
    ]);
    expect(n).toBe(2);
  });

  it("upserts two open loops in one statement", async () => {
    await migrate();
    const { scope } = await createUser({ phone_e164: "+1556" + String(Date.now()).slice(-7) });
    await upsertPerson(scope, { person_id: "p_c", display: "C" });
    const n = await upsertOpenLoops(scope, [
      { loop_id: "l_1", person_id: "p_c", kind: "question", direction: "they_owe_me", description: "one", opened_at: new Date(), confidence: "high", as_of: new Date() },
      { loop_id: "l_2", person_id: "p_c", kind: "promise", direction: "i_owe_them", description: "two", opened_at: new Date(), confidence: "medium", as_of: new Date() },
    ]);
    expect(n).toBe(2);
  });
});
