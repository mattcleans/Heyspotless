import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseRepository } from "./supabase-repository";
import { SupabaseOpsStore } from "./ops-store";
import { parseCustomer } from "./validate";

/**
 * The regression this file exists for.
 *
 * Notes were written by every update and read back by nothing: the column was
 * absent from the customer SELECT, from the mapper, from the domain type and
 * from the edit form's default value. The edit form posts every field it has,
 * so the textarea — empty, because there was nothing to prefill it with —
 * posted "" and the action dutifully wrote it. Changing a phone number erased
 * everything the office knew about that customer, silently, with a "Saved."
 *
 * Mapper unit tests would not have caught it, because each layer was
 * individually consistent. Only the round trip is. So this drives the real
 * store and the real repository against a table that behaves like PostgREST
 * does in the one way that matters here: it returns the columns that were
 * ASKED for, and nothing else. A fake that returned whole rows regardless of
 * the projection would pass while the bug was still there.
 */

interface Table {
  rows: Record<string, unknown>[];
}

function fakeSupabase(tables: Record<string, Table>): SupabaseClient {
  function project(row: Record<string, unknown>, columns: string) {
    const wanted = columns
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c !== "");
    const out: Record<string, unknown> = {};
    for (const column of wanted) {
      // Absent from the projection means absent from the result. This is the
      // whole point of the fake.
      if (column in row) out[column] = row[column];
    }
    return out;
  }

  function builder(table: string) {
    const state: {
      op: "select" | "insert" | "update";
      values?: Record<string, unknown>;
      columns: string;
      filters: [string, unknown][];
    } = { op: "select", columns: "*", filters: [] };

    const matching = () =>
      tables[table]!.rows.filter((row) =>
        state.filters.every(([column, value]) => row[column] === value),
      );

    const api = {
      select(columns = "*") {
        state.columns = columns;
        return api;
      },
      insert(values: Record<string, unknown>) {
        state.op = "insert";
        state.values = values;
        return api;
      },
      update(values: Record<string, unknown>) {
        state.op = "update";
        state.values = values;
        return api;
      },
      eq(column: string, value: unknown) {
        state.filters.push([column, value]);
        return api;
      },
      async single() {
        return api.run();
      },
      async maybeSingle() {
        return api.run();
      },
      async run() {
        if (state.op === "insert") {
          const row = { id: `cust-${tables[table]!.rows.length + 1}`, ...state.values };
          tables[table]!.rows.push(row);
          return { data: project(row, state.columns), error: null };
        }
        if (state.op === "update") {
          const hits = matching();
          for (const row of hits) Object.assign(row, state.values);
          const first = hits[0];
          return { data: first ? project(first, state.columns) : null, error: null };
        }
        const first = matching()[0];
        return { data: first ? project(first, state.columns) : null, error: null };
      },
    };
    return api;
  }

  return { from: (table: string) => builder(table) } as unknown as SupabaseClient;
}

/** What the edit form posts: every field it renders, as strings. */
function submission(fields: Record<string, string>) {
  const parsed = parseCustomer(fields);
  if (!parsed.ok) throw new Error(`fixture did not validate: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

describe("editing a customer", () => {
  it("keeps the notes when only the phone number changes", async () => {
    const db = fakeSupabase({ customers: { rows: [] } });
    const store = new SupabaseOpsStore(db);
    const repo = new SupabaseRepository(db);

    const created = await store.createCustomer(
      submission({
        firstName: "Bonnie",
        lastName: "Alvarez",
        phone: "(972) 555-0134",
        notes: "Gate code changes monthly. Text before arriving; the dog barks.",
      }),
    );
    expect(created.notes).toBe("Gate code changes monthly. Text before arriving; the dog barks.");

    // Reload, the way the edit page does.
    const reloaded = await repo.getCustomer(created.id);
    expect(reloaded?.notes).toBe(
      "Gate code changes monthly. Text before arriving; the dog barks.",
    );

    // The edit form, prefilled from that reload, with one field changed. The
    // notes textarea posts back what it was prefilled with — which is the
    // fix: before, it was prefilled with nothing.
    await store.updateCustomer(
      created.id,
      submission({
        firstName: reloaded!.firstName,
        lastName: reloaded!.lastName,
        phone: "(972) 555-0199",
        notes: reloaded!.notes ?? "",
      }),
    );

    const after = await repo.getCustomer(created.id);
    expect(after?.phone).toBe("9725550199");
    expect(after?.notes).toBe("Gate code changes monthly. Text before arriving; the dog barks.");
  });

  it("still lets an operator clear the notes on purpose", async () => {
    // The other half of the requirement. Preserving notes must not mean they
    // can never be removed — an emptied textarea is a deliberate act.
    const db = fakeSupabase({ customers: { rows: [] } });
    const store = new SupabaseOpsStore(db);
    const repo = new SupabaseRepository(db);

    const created = await store.createCustomer(
      submission({ firstName: "Ana", lastName: "Reyes", phone: "9725550110", notes: "Old note." }),
    );

    await store.updateCustomer(
      created.id,
      submission({ firstName: "Ana", lastName: "Reyes", phone: "9725550110", notes: "   " }),
    );

    expect((await repo.getCustomer(created.id))?.notes).toBeNull();
  });

  it("reads notes back out of the columns the repository asks for", async () => {
    // Guards the specific omission: `notes` missing from either SELECT list
    // makes this null even though the row has it.
    const db = fakeSupabase({
      customers: {
        rows: [
          {
            id: "cust-9",
            first_name: "Dana",
            last_name: "Cole",
            email: null,
            phone: "9725550188",
            notes: "Key under the pot.",
            lifetime_value_cents: 34000,
            stripe_customer_id: null,
            autopay_enabled: false,
            autopay_authorized_at: null,
          },
        ],
      },
    });

    expect((await new SupabaseRepository(db).getCustomer("cust-9"))?.notes).toBe(
      "Key under the pot.",
    );
  });
});
