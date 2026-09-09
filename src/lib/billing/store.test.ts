import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { BillingStore } from "./store";

/**
 * Claiming is the one piece of BillingStore that decides something rather than
 * just executing, and getting it wrong loses a payment silently — so it is
 * worth a test even though the rest of this class is a thin Supabase wrapper.
 *
 * The fake below is a real (tiny) `stripe_events` table rather than canned
 * responses: it enforces the primary key and honours the filters, so the
 * assertions are about behaviour and not about which methods got called. In
 * the spirit of events.test.ts — no SDK, no keys, no network.
 */
interface Row {
  id: string;
  type: string;
  payload: unknown;
  received_at: string;
  processed_at: string | null;
}

function fakeDb(rows: Row[]): SupabaseClient {
  const db = {
    from(table: string) {
      if (table !== "stripe_events") throw new Error(`unexpected table: ${table}`);
      return {
        insert(row: Record<string, unknown>) {
          if (rows.some((r) => r.id === row["id"])) {
            return Promise.resolve({ error: { code: "23505", message: "duplicate key" } });
          }
          // received_at/processed_at are column defaults in 0006, not something
          // the insert supplies, so they are filled in here the same way.
          rows.push({
            id: String(row["id"]),
            type: String(row["type"]),
            payload: row["payload"],
            received_at: new Date().toISOString(),
            processed_at: null,
          });
          return Promise.resolve({ error: null });
        },

        update(patch: Record<string, unknown>) {
          const filters: ((r: Row) => boolean)[] = [];
          const builder = {
            eq(col: keyof Row, v: unknown) {
              filters.push((r) => r[col] === v);
              return builder;
            },
            is(col: keyof Row, v: unknown) {
              filters.push((r) => r[col] === v);
              return builder;
            },
            lt(col: keyof Row, v: unknown) {
              // ISO-8601 UTC sorts lexicographically, same order as timestamptz.
              filters.push((r) => String(r[col]) < String(v));
              return builder;
            },
            select() {
              const matched = rows.filter((r) => filters.every((f) => f(r)));
              for (const r of matched) Object.assign(r, patch);
              return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
            },
          };
          return builder;
        },
      };
    },
  };
  return db as unknown as SupabaseClient;
}

function claimed(overrides: Partial<Row> = {}): Row {
  return {
    id: "evt_1",
    type: "checkout.session.completed",
    payload: {},
    received_at: new Date().toISOString(),
    processed_at: null,
    ...overrides,
  };
}

/** Older than the 5-minute abandonment window. */
function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

describe("claimEvent", () => {
  it("claims an event never seen before", async () => {
    const rows: Row[] = [];
    const store = new BillingStore(fakeDb(rows));

    expect(await store.claimEvent("evt_1", "charge.refunded", { a: 1 })).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("reports a duplicate while the first handler could still be running", async () => {
    const rows = [claimed({ received_at: minutesAgo(1) })];
    const store = new BillingStore(fakeDb(rows));

    expect(await store.claimEvent("evt_1", "checkout.session.completed", {})).toBe(false);
  });

  it("reports a duplicate for an event already processed", async () => {
    // Long past the window, but finished — the ordinary redelivery case, and the
    // one that must stay a no-op no matter how old it gets.
    const rows = [claimed({ received_at: minutesAgo(60), processed_at: minutesAgo(59) })];
    const store = new BillingStore(fakeDb(rows));

    expect(await store.claimEvent("evt_1", "checkout.session.completed", {})).toBe(false);
  });

  it("takes over a claim whose handler died before finishing", async () => {
    // The failure this guards: without the takeover Stripe's retry is waved
    // through as a duplicate, and the payment is never applied.
    const rows = [claimed({ received_at: minutesAgo(30) })];
    const store = new BillingStore(fakeDb(rows));

    expect(await store.claimEvent("evt_1", "checkout.session.completed", {})).toBe(true);
  });

  it("only lets one delivery take over an abandoned claim", async () => {
    const rows = [claimed({ received_at: minutesAgo(30) })];
    const store = new BillingStore(fakeDb(rows));

    expect(await store.claimEvent("evt_1", "checkout.session.completed", {})).toBe(true);
    // The takeover refreshed received_at, so a delivery arriving alongside it
    // now sees a live claim.
    expect(await store.claimEvent("evt_1", "checkout.session.completed", {})).toBe(false);
  });
});

// --- saveCard -------------------------------------------------------------

interface CardRow {
  customer_id: string;
  stripe_payment_method_id: string;
  is_default: boolean;
  detached_at: string | null;
}

/** A `payment_methods` table with just the columns saveCard touches. */
function fakeCardDb(rows: CardRow[]): SupabaseClient {
  const db = {
    from(table: string) {
      if (table !== "payment_methods") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          const filters: ((r: CardRow) => boolean)[] = [];
          const builder = {
            eq(col: keyof CardRow, v: unknown) {
              filters.push((r) => r[col] === v);
              return builder;
            },
            is(col: keyof CardRow, v: unknown) {
              filters.push((r) => r[col] === v);
              return builder;
            },
            neq(col: keyof CardRow, v: unknown) {
              filters.push((r) => r[col] !== v);
              return builder;
            },
            limit(n: number) {
              const matched = rows.filter((r) => filters.every((f) => f(r))).slice(0, n);
              return Promise.resolve({ data: matched, error: null });
            },
          };
          return builder;
        },

        upsert(row: Record<string, unknown>) {
          const pm = row["stripe_payment_method_id"];
          const existing = rows.find((r) => r.stripe_payment_method_id === pm);
          if (existing) Object.assign(existing, row);
          else rows.push(row as unknown as CardRow);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return db as unknown as SupabaseClient;
}

const card = { brand: "visa", last4: "4242", expMonth: 1, expYear: 2030 };

function cardRow(pm: string, isDefault: boolean): CardRow {
  return {
    customer_id: "cus-1",
    stripe_payment_method_id: pm,
    is_default: isDefault,
    detached_at: null,
  };
}

describe("saveCard", () => {
  it("makes a customer's first card their default", async () => {
    const rows: CardRow[] = [];
    await new BillingStore(fakeCardDb(rows)).saveCard("cus-1", {
      paymentMethodId: "pm_1",
      ...card,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_default).toBe(true);
  });

  it("keeps the default when Stripe redelivers a card already on file", async () => {
    // The failure this guards: counting the card itself as "an existing card"
    // concludes it is not the first, clears is_default, and autocharge — which
    // filters on is_default — silently stops charging this customer.
    const rows = [cardRow("pm_1", true)];
    await new BillingStore(fakeCardDb(rows)).saveCard("cus-1", {
      paymentMethodId: "pm_1",
      ...card,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_default).toBe(true);
  });

  it("does not make a genuinely new second card the default", async () => {
    const rows = [cardRow("pm_1", true)];
    await new BillingStore(fakeCardDb(rows)).saveCard("cus-1", {
      paymentMethodId: "pm_2",
      ...card,
    });

    expect(rows.find((r) => r.stripe_payment_method_id === "pm_1")?.is_default).toBe(true);
    expect(rows.find((r) => r.stripe_payment_method_id === "pm_2")?.is_default).toBe(false);
  });

  it("does not let a redelivered second card steal the default", async () => {
    const rows = [cardRow("pm_1", true), cardRow("pm_2", false)];
    await new BillingStore(fakeCardDb(rows)).saveCard("cus-1", {
      paymentMethodId: "pm_2",
      ...card,
    });

    expect(rows.find((r) => r.stripe_payment_method_id === "pm_1")?.is_default).toBe(true);
    expect(rows.find((r) => r.stripe_payment_method_id === "pm_2")?.is_default).toBe(false);
  });
});
