import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { BillingStore } from "./store";
import { BillChangedError } from "./types";

describe("reviewed payment claim", () => {
  it("keeps an open operation in the sweep hold set after its local deadline", async () => {
    const query = { select: () => query, in: () => query, eq: async () => ({ data: [{ invoice_id: "expired", expires_at: "2000-01-01T00:00:00Z" }, { invoice_id: "current", expires_at: "2100-01-01T00:00:00Z" }], error: null }) };
    const db = { from: () => query } as unknown as SupabaseClient;
    expect(await new BillingStore(db).invoiceIdsWithOpenCollection(["expired", "current"])).toEqual(new Set(["expired", "current"]));
  });
  it("sends the reviewed owner and balance separately from an additional tip", async () => {
    const { db, calls } = fakeRpc(() => ({ data: [{ outcome: "started", operation_id: "op", channel: "checkout", idempotency_key: "key", stripe_object_id: null, stripe_object_kind: null, redirect_url: null, amount_cents: 19000 }], error: null }));
    const result = await new BillingStore(db).beginPaymentOperation({ invoiceId: "invoice", channel: "checkout", idempotencyKey: "key", amountCents: 19000, expectedBalanceCents: 17000, expectedCustomerId: "customer", tipCents: 2000, ttlSeconds: 900 });
    expect(result).toMatchObject({ outcome: "started", amountCents: 19000 });
    expect(calls).toEqual([{ fn: "begin_reviewed_payment_operation", args: { p_invoice_id: "invoice", p_channel: "checkout", p_idempotency_key: "key", p_amount_cents: 19000, p_expected_balance_cents: 17000, p_expected_customer_id: "customer", p_tip_cents: 2000, p_ttl_seconds: 900 } }]);
  });
  it("maps a changed bill to a safe review message without private database text", async () => {
    const { db } = fakeRpc(() => ({ data: null, error: { code: "PT409", message: "private database detail" } }));
    const claim = new BillingStore(db).beginPaymentOperation({ invoiceId: "invoice", channel: "checkout", idempotencyKey: "key", amountCents: 17000, expectedBalanceCents: 17000, expectedCustomerId: "customer" });
    await expect(claim).rejects.toBeInstanceOf(BillChangedError);
    await expect(claim).rejects.toThrow("Refresh Account");
    await expect(claim).rejects.not.toThrow("private database detail");
  });
  it("preserves genuine database failures as failures", async () => {
    const { db } = fakeRpc(() => ({ data: null, error: { code: "40001", message: "serialization failure" } }));
    await expect(new BillingStore(db).beginPaymentOperation({ invoiceId: "invoice", channel: "checkout", idempotencyKey: "key", amountCents: 17000, expectedBalanceCents: 17000, expectedCustomerId: "customer" })).rejects.not.toBeInstanceOf(BillChangedError);
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


// --- webhook events -------------------------------------------------------

/**
 * The claim RULES — completed vs processing vs abandoned, and lease
 * ownership — live in 0010 and are asserted against real Postgres in
 * scripts/verify-migrations.sh, including two overlapping connections and a
 * handler that dies holding a lease.
 *
 * Left here: that the store asks the right question and reads the answer
 * honestly. An unrecognised outcome must RAISE rather than be coerced into
 * one of the three, because silently treating an unknown value as "completed"
 * would resurrect the bug this whole change is about.
 */
describe("claimEvent", () => {
  it("passes the event, the owner and the lease through", async () => {
    const { db, calls } = fakeRpc(() => ({ data: "claimed", error: null }));

    expect(await new BillingStore(db).claimEvent("evt_1", "charge.refunded", { a: 1 }, "own-1", 30))
      .toBe("claimed");
    expect(calls).toEqual([
      {
        fn: "claim_stripe_event",
        args: {
          p_id: "evt_1",
          p_type: "charge.refunded",
          p_payload: { a: 1 },
          p_owner: "own-1",
          p_lease_seconds: 30,
        },
      },
    ]);
  });

  it("reports each of the three outcomes as itself", async () => {
    for (const outcome of ["claimed", "completed", "processing"] as const) {
      const { db } = fakeRpc(() => ({ data: outcome, error: null }));
      expect(await new BillingStore(db).claimEvent("evt_1", "t", {}, "own-1")).toBe(outcome);
    }
  });

  it("refuses to guess at an outcome it does not recognise", async () => {
    // Coercing an unexpected value into "completed" would acknowledge an
    // event nobody processed, which is the failure this change exists to fix.
    const { db } = fakeRpc(() => ({ data: null, error: null }));
    await expect(new BillingStore(db).claimEvent("evt_1", "t", {}, "own-1")).rejects.toThrow(
      /unexpected outcome/,
    );
  });
});

describe("finishEvent and releaseEvent", () => {
  it("reports success when this handler still holds the lease", async () => {
    const { db, calls } = fakeRpc(() => ({ data: true, error: null }));
    const store = new BillingStore(db);

    expect(await store.finishEvent("evt_1", "own-1", "applied")).toBe(true);
    expect(await store.releaseEvent("evt_1", "own-1", "boom")).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(["finish_stripe_event", "release_stripe_event"]);
    expect(calls[0]?.args).toEqual({
      p_id: "evt_1",
      p_owner: "own-1",
      p_outcome: "applied",
      p_error: null,
    });
    expect(calls[1]?.args).toEqual({ p_id: "evt_1", p_owner: "own-1", p_error: "boom" });
  });

  it("reports failure when the lease has moved to another handler", async () => {
    const { db } = fakeRpc(() => ({ data: false, error: null }));
    const store = new BillingStore(db);

    expect(await store.finishEvent("evt_1", "stale-owner", "applied")).toBe(false);
    expect(await store.releaseEvent("evt_1", "stale-owner")).toBe(false);
  });
});
