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

// --- cards ----------------------------------------------------------------

/**
 * The default-card RULES now live in `save_payment_method` and
 * `detach_payment_method` (0009), under a lock on the customer row, because
 * they are a read-modify-write that two webhook deliveries can enter at once.
 * They are asserted against real Postgres in scripts/verify-migrations.sh —
 * including the two-card replay that broke the previous fix, detachment,
 * replacement, and two genuinely concurrent connections.
 *
 * Re-implementing those rules in a fake here would only assert that the fake
 * agrees with itself. What is left to check in TypeScript is the wiring: the
 * right function, the right arguments, and an honest reading of the result.
 */
interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function fakeRpc(
  respond: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown },
): { db: SupabaseClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const db = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(respond(fn, args));
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

describe("saveCard", () => {
  it("hands the card to save_payment_method with every field Stripe gave us", async () => {
    const { db, calls } = fakeRpc(() => ({ data: true, error: null }));

    const isDefault = await new BillingStore(db).saveCard("cus-1", {
      paymentMethodId: "pm_1",
      brand: "visa",
      last4: "4242",
      expMonth: 1,
      expYear: 2030,
    });

    expect(isDefault).toBe(true);
    expect(calls).toEqual([
      {
        fn: "save_payment_method",
        args: {
          p_customer_id: "cus-1",
          p_stripe_payment_method_id: "pm_1",
          p_brand: "visa",
          p_last4: "4242",
          p_exp_month: 1,
          p_exp_year: 2030,
        },
      },
    ]);
  });

  it("reports a card that did not become the default", async () => {
    const { db } = fakeRpc(() => ({ data: false, error: null }));
    expect(
      await new BillingStore(db).saveCard("cus-1", {
        paymentMethodId: "pm_2",
        brand: null,
        last4: null,
        expMonth: null,
        expYear: null,
      }),
    ).toBe(false);
  });

  it("raises rather than pretending a failed save worked", async () => {
    const { db } = fakeRpc(() => ({ data: null, error: { message: "deadlock detected" } }));
    await expect(
      new BillingStore(db).saveCard("cus-1", {
        paymentMethodId: "pm_1",
        brand: null,
        last4: null,
        expMonth: null,
        expYear: null,
      }),
    ).rejects.toThrow(/deadlock detected/);
  });
});

describe("detachCard", () => {
  it("returns the card that took over as default", async () => {
    const { db, calls } = fakeRpc(() => ({ data: "pm_2", error: null }));

    expect(await new BillingStore(db).detachCard("pm_1")).toBe("pm_2");
    expect(calls).toEqual([
      { fn: "detach_payment_method", args: { p_stripe_payment_method_id: "pm_1" } },
    ]);
  });

  it("returns null when no card is left, which is how autopay gets suspended", async () => {
    const { db } = fakeRpc(() => ({ data: null, error: null }));
    expect(await new BillingStore(db).detachCard("pm_1")).toBeNull();
  });
});
