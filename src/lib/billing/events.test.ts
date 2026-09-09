import { describe, expect, it } from "vitest";
import { type StripeEventLike, toTransition } from "./events";

/**
 * The payloads below are trimmed to the fields the mapper reads, in the shape
 * Stripe actually sends them. Keeping them as plain objects is the point: the
 * mapping is the part with the bugs in it, and it can be exercised with no SDK,
 * no keys and no network.
 */
function event(type: string, object: Record<string, unknown>): StripeEventLike {
  return { id: "evt_test", type, data: { object } };
}

describe("checkout.session.completed", () => {
  const session = {
    id: "cs_1",
    mode: "payment",
    payment_status: "paid",
    payment_intent: "pi_1",
    amount_total: 19000,
    metadata: { invoice_id: "inv-1", tip_cents: "2000" },
  };

  it("settles the invoice named in metadata", () => {
    expect(toTransition(event("checkout.session.completed", session))).toEqual({
      kind: "payment_succeeded",
      invoiceId: "inv-1",
      paymentIntentId: "pi_1",
      amountCents: 19000,
      tipCents: 2000,
    });
  });

  it("reads a tip of zero when none was given", () => {
    const noTip = { ...session, metadata: { invoice_id: "inv-1" }, amount_total: 17000 };
    expect(toTransition(event("checkout.session.completed", noTip))).toMatchObject({
      amountCents: 17000,
      tipCents: 0,
    });
  });

  it("ignores a session with no invoice_id rather than guessing from the amount", () => {
    const orphan = { ...session, metadata: {} };
    expect(toTransition(event("checkout.session.completed", orphan))).toMatchObject({
      kind: "ignored",
    });
  });

  it("ignores a completed session that was not actually paid", () => {
    const unpaid = { ...session, payment_status: "unpaid" };
    expect(toTransition(event("checkout.session.completed", unpaid))).toMatchObject({
      kind: "ignored",
    });
  });

  it("ignores a setup-mode session, which is handled as payment_method.attached", () => {
    const setup = { id: "cs_2", mode: "setup", metadata: { invoice_id: "inv-1" } };
    expect(toTransition(event("checkout.session.completed", setup))).toMatchObject({
      kind: "ignored",
    });
  });
});

describe("payment_intent", () => {
  it("settles on success, preferring amount_received", () => {
    const pi = {
      id: "pi_1",
      amount: 19000,
      amount_received: 17000,
      metadata: { invoice_id: "inv-1" },
    };
    expect(toTransition(event("payment_intent.succeeded", pi))).toMatchObject({
      kind: "payment_succeeded",
      amountCents: 17000,
    });
  });

  it("records the decline code on failure", () => {
    const pi = {
      id: "pi_1",
      metadata: { invoice_id: "inv-1" },
      last_payment_error: { code: "card_declined", message: "Your card was declined." },
    };
    expect(toTransition(event("payment_intent.payment_failed", pi))).toEqual({
      kind: "payment_failed",
      invoiceId: "inv-1",
      paymentIntentId: "pi_1",
      failureCode: "card_declined",
      failureMessage: "Your card was declined.",
    });
  });

  it("falls back to the decline_code when there is no code", () => {
    const pi = {
      id: "pi_1",
      metadata: { invoice_id: "inv-1" },
      last_payment_error: { decline_code: "insufficient_funds" },
    };
    expect(toTransition(event("payment_intent.payment_failed", pi))).toMatchObject({
      failureCode: "insufficient_funds",
      failureMessage: null,
    });
  });

  it("ignores a failure with no invoice_id", () => {
    const pi = { id: "pi_1", metadata: {} };
    expect(toTransition(event("payment_intent.payment_failed", pi))).toMatchObject({
      kind: "ignored",
    });
  });
});

describe("payment methods", () => {
  it("saves the card metadata, and only the metadata", () => {
    const pm = {
      id: "pm_1",
      customer: "cus_1",
      card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 },
    };
    expect(toTransition(event("payment_method.attached", pm))).toEqual({
      kind: "card_saved",
      stripeCustomerId: "cus_1",
      paymentMethodId: "pm_1",
      brand: "visa",
      last4: "4242",
      expMonth: 4,
      expYear: 2030,
    });
  });

  it("ignores a payment method attached to nobody", () => {
    expect(toTransition(event("payment_method.attached", { id: "pm_1" }))).toMatchObject({
      kind: "ignored",
    });
  });

  it("survives a non-card payment method with no card block", () => {
    const pm = { id: "pm_1", customer: "cus_1", type: "us_bank_account" };
    expect(toTransition(event("payment_method.attached", pm))).toMatchObject({
      kind: "card_saved",
      brand: null,
      last4: null,
    });
  });

  it("detaches a removed card", () => {
    expect(toTransition(event("payment_method.detached", { id: "pm_1" }))).toEqual({
      kind: "card_detached",
      paymentMethodId: "pm_1",
    });
  });
});

describe("charge.refunded", () => {
  /**
   * The trap this guards: `amount_refunded` on the charge is CUMULATIVE. Two
   * $50 refunds on a $170 charge arrive as amount_refunded 5000 then 10000, so
   * applying that field as a delta refunds $150 against a $100 reality.
   */
  it("applies the newest refund, not the cumulative total", () => {
    const charge = {
      id: "ch_1",
      payment_intent: "pi_1",
      amount_refunded: 10000,
      refunds: { data: [{ id: "re_2", amount: 5000 }, { id: "re_1", amount: 5000 }] },
    };
    expect(toTransition(event("charge.refunded", charge))).toEqual({
      kind: "refund_succeeded",
      paymentIntentId: "pi_1",
      chargeId: "ch_1",
      amountCents: 5000,
      stripeRefundId: "re_2",
    });
  });

  it("falls back to amount_refunded when the refund list is absent", () => {
    const charge = { id: "ch_1", payment_intent: "pi_1", amount_refunded: 5000 };
    expect(toTransition(event("charge.refunded", charge))).toMatchObject({
      amountCents: 5000,
      stripeRefundId: null,
    });
  });

  it("ignores a refund carrying no amount", () => {
    expect(toTransition(event("charge.refunded", { id: "ch_1" }))).toMatchObject({
      kind: "ignored",
    });
  });
});

describe("events we do not handle", () => {
  /**
   * Stripe retries a non-2xx for three days. Returning `ignored` rather than
   * throwing is what stops someone enabling an unrelated event in the dashboard
   * and producing a retry storm against this endpoint.
   */
  it("are ignored rather than thrown", () => {
    expect(toTransition(event("customer.subscription.updated", { id: "sub_1" }))).toEqual({
      kind: "ignored",
      type: "customer.subscription.updated",
      reason: "unhandled event type",
    });
  });

  it("survive an event with an empty object", () => {
    expect(toTransition(event("payment_intent.succeeded", {})).kind).toBe("ignored");
  });

  it("survive junk in fields that should be strings", () => {
    const pm = { id: 12345, customer: { nested: true } } as unknown as Record<string, unknown>;
    expect(toTransition(event("payment_method.attached", pm)).kind).toBe("ignored");
  });
});
