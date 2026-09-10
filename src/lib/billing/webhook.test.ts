import { describe, expect, it, vi } from "vitest";
import type { BillingStore } from "./store";
import type { EventClaim } from "./store";
import type { StripeEventLike } from "./events";
import { handleStripeEvent } from "./webhook";

/**
 * The RESPONSE behaviour of the webhook endpoint.
 *
 * Testing the store's claim function alone is not enough and never was: the
 * store could return a perfectly correct "someone else is working on this"
 * and the route still lose the payment by answering 200 to it. Stripe stops
 * retrying on any 2xx, so which status each outcome gets IS the recovery
 * mechanism. That is what this file asserts.
 *
 * The fake store below models the parts of 0010 the route depends on: a
 * single event row with a state and a lease owner, and finish/release that
 * only work for the owner holding it. It is small enough to read and strict
 * enough that a route which ignores ownership fails here.
 */

interface EventRow {
  state: "processing" | "done" | "failed";
  owner: string | null;
  expiresAt: number | null;
  attempts: number;
  outcome: string | null;
}

interface Harness {
  store: BillingStore;
  events: Map<string, EventRow>;
  recorded: { paymentIntents: string[]; refundKinds: string[]; settlements: string[] };
  /** Expire the lease on an event, as a dead handler's would. */
  expireLease(id: string): void;
}

function harness(
  options: { now?: () => number; onRecordPayment?: () => Promise<string | null> } = {},
): Harness {
  const events = new Map<string, EventRow>();
  const recorded = {
    paymentIntents: [] as string[],
    refundKinds: [] as string[],
    settlements: [] as string[],
  };
  const now = options.now ?? (() => Date.now());
  const LEASE_MS = 300_000;

  const store = {
    async claimEvent(
      id: string,
      _type: string,
      _payload: unknown,
      owner: string,
    ): Promise<EventClaim> {
      const row = events.get(id);
      if (!row) {
        events.set(id, {
          state: "processing",
          owner,
          expiresAt: now() + LEASE_MS,
          attempts: 1,
          outcome: null,
        });
        return "claimed";
      }
      if (row.state === "done") return "completed";
      if (row.state === "processing" && row.expiresAt !== null && row.expiresAt > now()) {
        return "processing";
      }
      // Abandoned, or released after a failure. Taking it over rewrites the
      // owner, which is what invalidates the previous holder.
      row.state = "processing";
      row.owner = owner;
      row.expiresAt = now() + LEASE_MS;
      row.attempts += 1;
      return "claimed";
    },

    async finishEvent(id: string, owner: string, outcome: string): Promise<boolean> {
      const row = events.get(id);
      if (!row || row.owner !== owner) return false;
      row.state = "done";
      row.owner = null;
      row.expiresAt = null;
      row.outcome = outcome;
      return true;
    },

    async releaseEvent(id: string, owner: string): Promise<boolean> {
      const row = events.get(id);
      if (!row || row.owner !== owner) return false;
      row.state = "failed";
      row.owner = null;
      row.expiresAt = null;
      return true;
    },

    async recordPayment(args: { stripePaymentIntentId?: string | null }): Promise<string | null> {
      if (options.onRecordPayment) return options.onRecordPayment();
      const intent = args.stripePaymentIntentId ?? "";
      // Idempotent on the payment intent, exactly as record_payment is.
      if (recorded.paymentIntents.includes(intent)) return null;
      recorded.paymentIntents.push(intent);
      return `pay_${recorded.paymentIntents.length}`;
    },

    async recordPaymentFailure(): Promise<void> {},
    async findCustomerIdByStripeId(): Promise<string | null> {
      return "cus-1";
    },
    async saveCard(): Promise<boolean> {
      return true;
    },
    async detachCard(): Promise<string | null> {
      return "pm_2";
    },
    async recordRefund(args: { kind?: string }): Promise<string | null> {
      recorded.refundKinds.push(args.kind ?? "unstated");
      return "ref_1";
    },
    async settleRefund(_id: string, status: string): Promise<string> {
      recorded.settlements.push(status);
      return status;
    },
  } as unknown as BillingStore;

  return {
    store,
    events,
    recorded,
    expireLease(id: string) {
      const row = events.get(id);
      if (row) row.expiresAt = now() - 1;
    },
  };
}

function paymentEvent(id: string, intent = "pi_1", amount = 17000): StripeEventLike {
  return {
    id,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: intent,
        amount_received: amount,
        metadata: { invoice_id: "inv-1" },
      },
    },
  };
}

describe("the webhook's response to Stripe", () => {
  it("applies a first delivery and acknowledges it", async () => {
    const h = harness();
    const result = await handleStripeEvent(h.store, paymentEvent("evt_1"));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, outcome: "applied" });
    expect(h.recorded.paymentIntents).toEqual(["pi_1"]);
  });

  it("acknowledges a redelivery of an event that really is finished", async () => {
    const h = harness();
    await handleStripeEvent(h.store, paymentEvent("evt_1"));
    const again = await handleStripeEvent(h.store, paymentEvent("evt_1"));

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true, duplicate: true });
    // And the money moved exactly once.
    expect(h.recorded.paymentIntents).toEqual(["pi_1"]);
  });

  it("refuses to acknowledge an event another handler is still working on", async () => {
    // THE BUG. A retry arriving inside the old five-minute window was answered
    // 200 {duplicate: true}. Stripe stopped retrying. If the first handler
    // then died, the payment was never applied and nothing said so.
    const h = harness();
    h.events.set("evt_1", {
      state: "processing",
      owner: "another-handler",
      expiresAt: Date.now() + 60_000,
      attempts: 1,
      outcome: null,
    });

    const result = await handleStripeEvent(h.store, paymentEvent("evt_1"));

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ received: false, retry: true });
    expect(h.recorded.paymentIntents).toEqual([]);
  });

  it("processes the retry once an abandoned lease has expired", async () => {
    // Process termination after claiming: the row is left `processing` with a
    // lease nobody holds. The next delivery must take it over and apply it.
    const h = harness();
    h.events.set("evt_1", {
      state: "processing",
      owner: "handler-that-died",
      expiresAt: Date.now() - 1,
      attempts: 1,
      outcome: null,
    });

    const result = await handleStripeEvent(h.store, paymentEvent("evt_1"));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, outcome: "applied" });
    expect(h.recorded.paymentIntents).toEqual(["pi_1"]);
    expect(h.events.get("evt_1")?.attempts).toBe(2);
  });

  it("asks for a retry, and keeps the event alive, when the handler throws", async () => {
    // A database failure mid-processing. Stripe must retry, and the claim must
    // be given back so the retry does not have to wait out the whole lease.
    const failing = harness({
      onRecordPayment: () => Promise.reject(new Error("connection terminated")),
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handleStripeEvent(failing.store, paymentEvent("evt_1"));

    expect(result.status).toBe(500);
    expect(failing.events.get("evt_1")?.state).toBe("failed");
    expect(failing.events.get("evt_1")?.owner).toBeNull();
    error.mockRestore();
  });

  it("lets the next delivery pick up an event a failed handler released", async () => {
    let failNext = true;
    const h = harness({
      onRecordPayment: () => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("connection terminated"));
        }
        return Promise.resolve("pay_1");
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await handleStripeEvent(h.store, paymentEvent("evt_1"))).status).toBe(500);
    const retry = await handleStripeEvent(h.store, paymentEvent("evt_1"));

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ received: true, outcome: "applied" });
    error.mockRestore();
  });

  it("does not let a handler that lost its lease report the event finished", async () => {
    // A handler runs long, its lease expires, another takes the event over.
    // The slow one must not mark the event done — the new owner has not
    // finished — and must not tell Stripe to stop retrying.
    const h = harness({
      onRecordPayment: async () => {
        // While "we" were working, a second delivery took the event over.
        const row = h.events.get("evt_1");
        if (row) row.owner = "the-handler-that-took-over";
        return "pay_1";
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await handleStripeEvent(h.store, paymentEvent("evt_1"));

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ status: "lease_lost", retry: true });
    // The event is still owned by the handler that took it over, still
    // unfinished, and still retryable.
    expect(h.events.get("evt_1")?.state).toBe("processing");
    expect(h.events.get("evt_1")?.owner).toBe("the-handler-that-took-over");
    warn.mockRestore();
  });

  it("collapses two concurrent deliveries of the same event to one application", async () => {
    // Both arrive at once. One claims and applies; the other must NOT be told
    // "received", because the first has not finished yet.
    const h = harness();
    const [first, second] = await Promise.all([
      handleStripeEvent(h.store, paymentEvent("evt_1")),
      handleStripeEvent(h.store, paymentEvent("evt_1")),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(h.recorded.paymentIntents).toEqual(["pi_1"]);
  });

  it("keeps out-of-order events apart rather than confusing one for another", async () => {
    // A refund arriving before the payment's own webhook, and a second
    // distinct payment. Different event ids are different claims.
    const h = harness();
    const a = await handleStripeEvent(h.store, paymentEvent("evt_a", "pi_a"));
    const b = await handleStripeEvent(h.store, paymentEvent("evt_b", "pi_b"));

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(h.recorded.paymentIntents).toEqual(["pi_a", "pi_b"]);
  });

  it("acknowledges an event type it does not handle instead of retrying forever", async () => {
    const h = harness();
    const result = await handleStripeEvent(h.store, {
      id: "evt_x",
      type: "customer.subscription.trial_will_end",
      data: { object: {} },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, outcome: "ignored" });
  });

  it("records a second delivery of an already-applied capture as already_recorded", async () => {
    // Two DIFFERENT Stripe events for one payment intent — a checkout session
    // and the payment intent itself. The second is a genuine claim, and the
    // no-op comes from record_payment rather than from the claim.
    const h = harness();
    await handleStripeEvent(h.store, paymentEvent("evt_1", "pi_1"));
    const second = await handleStripeEvent(h.store, paymentEvent("evt_2", "pi_1"));

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, outcome: "already_recorded" });
    expect(h.recorded.paymentIntents).toEqual(["pi_1"]);
  });
});

describe("refunds arriving through the webhook", () => {
  it("records a dashboard refund as goodwill, so it cannot become a charge", async () => {
    // A refund we did not initiate carries no stated intent. Reading it as a
    // correction would restore the balance and — with autopay on — take the
    // money straight back off the customer's card. An apology must not bill.
    const h = harness();
    const result = await handleStripeEvent(h.store, {
      id: "evt_r",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: "pi_1",
          refunds: { data: [{ id: "re_1", amount: 5000 }] },
        },
      },
    });

    expect(result.status).toBe(200);
    expect(h.recorded.refundKinds).toEqual(["goodwill"]);
  });

  it("passes a later failure through to settlement rather than ignoring it", async () => {
    const h = harness();
    const result = await handleStripeEvent(h.store, {
      id: "evt_rf",
      type: "refund.updated",
      data: { object: { id: "re_1", status: "failed" } },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true, outcome: "refund_failed" });
    expect(h.recorded.settlements).toEqual(["failed"]);
  });

  it("applies a refund that succeeds after being pending", async () => {
    const h = harness();
    const result = await handleStripeEvent(h.store, {
      id: "evt_rs",
      type: "refund.updated",
      data: { object: { id: "re_1", status: "succeeded" } },
    });

    expect(result.body).toEqual({ received: true, outcome: "refund_succeeded" });
    expect(h.recorded.settlements).toEqual(["succeeded"]);
  });
});
