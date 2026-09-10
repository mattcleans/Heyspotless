import { describe, expect, it, vi } from "vitest";
import type { BillingStore, PaymentOperation } from "./store";
import { checkoutKeyFor, reconcileInvoiceCollection } from "./collection";
import * as gateway from "./gateway";

/**
 * Collecting each obligation at most once.
 *
 * The three cases the brief names — two Checkout tabs, repeated submissions,
 * and Checkout overlapping the auto-charge sweep — are all the same failure:
 * nothing recorded that a collection attempt was in flight, so anything that
 * looked at the invoice saw an unpaid invoice and started again.
 *
 * The fourth case is the uncertain one. If Stripe succeeded but the response
 * or the write was lost, the invoice ALSO reads as unpaid, and a retry takes
 * the same money again. "We do not know" is not "it failed", and the only
 * safe answer to it is to go and ask, which is what reconcile does.
 *
 * `begin_payment_operation` below is a faithful stand-in for 0012: one open
 * operation per invoice, enforced, with an expiry.
 */

interface OperationRow {
  invoiceId: string;
  channel: "checkout" | "autocharge";
  idempotencyKey: string;
  state: "open" | "succeeded" | "failed" | "abandoned";
  amountCents: number;
  stripeObjectId: string | null;
  stripeObjectKind: "checkout_session" | "payment_intent" | null;
  redirectUrl: string | null;
  expiresAt: number;
}

interface Ledger {
  store: BillingStore;
  operations: OperationRow[];
  payments: { intent: string | null; amountCents: number }[];
}

function ledger(now = () => Date.now()): Ledger {
  const operations: OperationRow[] = [];
  const payments: { intent: string | null; amountCents: number }[] = [];

  const openFor = (invoiceId: string) =>
    operations.find(
      (o) => o.invoiceId === invoiceId && o.state === "open" && o.expiresAt > now(),
    ) ?? null;

  const asOperation = (
    row: OperationRow,
    outcome: PaymentOperation["outcome"],
  ): PaymentOperation => ({
    outcome,
    id: row.idempotencyKey,
    channel: row.channel,
    idempotencyKey: row.idempotencyKey,
    stripeObjectId: row.stripeObjectId,
    stripeObjectKind: row.stripeObjectKind,
    redirectUrl: row.redirectUrl,
    amountCents: row.amountCents,
  });

  const store = {
    async beginPaymentOperation(args: {
      invoiceId: string;
      channel: "checkout" | "autocharge";
      idempotencyKey: string;
      amountCents: number;
    }): Promise<PaymentOperation> {
      // Expire anything nobody came back for, as 0012 does.
      for (const row of operations) {
        if (row.state === "open" && row.expiresAt <= now()) row.state = "abandoned";
      }

      const open = openFor(args.invoiceId);
      if (open) {
        return asOperation(open, open.idempotencyKey === args.idempotencyKey ? "existing" : "blocked");
      }

      const byKey = operations.find((o) => o.idempotencyKey === args.idempotencyKey);
      if (byKey) return asOperation(byKey, "existing");

      const row: OperationRow = {
        invoiceId: args.invoiceId,
        channel: args.channel,
        idempotencyKey: args.idempotencyKey,
        state: "open",
        amountCents: args.amountCents,
        stripeObjectId: null,
        stripeObjectKind: null,
        redirectUrl: null,
        expiresAt: now() + 900_000,
      };
      operations.push(row);
      return asOperation(row, "started");
    },

    async attachPaymentOperation(args: {
      idempotencyKey: string;
      stripeObjectKind: "checkout_session" | "payment_intent";
      stripeObjectId: string;
      redirectUrl?: string | null;
    }): Promise<boolean> {
      const row = operations.find((o) => o.idempotencyKey === args.idempotencyKey && o.state === "open");
      if (!row) return false;
      row.stripeObjectKind = args.stripeObjectKind;
      row.stripeObjectId = args.stripeObjectId;
      row.redirectUrl = args.redirectUrl ?? row.redirectUrl;
      return true;
    },

    async resolvePaymentOperation(key: string, state: OperationRow["state"]): Promise<boolean> {
      const row = operations.find((o) => o.idempotencyKey === key && o.state === "open");
      if (!row) return false;
      row.state = state;
      return true;
    },

    async openPaymentOperation(invoiceId: string): Promise<PaymentOperation | null> {
      const row = openFor(invoiceId);
      return row ? asOperation(row, "existing") : null;
    },

    async recordPayment(args: {
      stripePaymentIntentId?: string | null;
      amountCents: number;
    }): Promise<string | null> {
      // Idempotent on the payment intent, exactly as record_payment is.
      if (args.stripePaymentIntentId &&
          payments.some((p) => p.intent === args.stripePaymentIntentId)) {
        return null;
      }
      payments.push({ intent: args.stripePaymentIntentId ?? null, amountCents: args.amountCents });
      return `pay_${payments.length}`;
    },
  } as unknown as BillingStore;

  return { store, operations, payments };
}

describe("checkoutKeyFor", () => {
  it("gives two tabs settling the same balance the same key", () => {
    // This is what collapses them into one session instead of two chargeable
    // pages. Nothing else about the two requests is distinguishable.
    expect(checkoutKeyFor("inv-1", 17000, 0)).toBe(checkoutKeyFor("inv-1", 17000, 0));
  });

  it("gives a genuinely different obligation a different key", () => {
    // A part payment changes the balance, so the next attempt is a new one.
    expect(checkoutKeyFor("inv-1", 17000, 0)).not.toBe(checkoutKeyFor("inv-1", 7000, 0));
    expect(checkoutKeyFor("inv-1", 17000, 0)).not.toBe(checkoutKeyFor("inv-1", 17000, 2000));
    expect(checkoutKeyFor("inv-1", 17000, 0)).not.toBe(checkoutKeyFor("inv-2", 17000, 0));
  });
});

describe("one open attempt per invoice", () => {
  it("gives the second of two identical tabs the attempt that already exists", async () => {
    const l = ledger();
    const key = checkoutKeyFor("inv-1", 17000, 0);

    const first = await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: key,
      amountCents: 17000,
    });
    await l.store.attachPaymentOperation({
      idempotencyKey: key,
      stripeObjectKind: "checkout_session",
      stripeObjectId: "cs_1",
      redirectUrl: "https://checkout.stripe.test/cs_1",
    });

    const second = await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: key,
      amountCents: 17000,
    });

    expect(first.outcome).toBe("started");
    expect(second.outcome).toBe("existing");
    expect(second.redirectUrl).toBe("https://checkout.stripe.test/cs_1");
    // One attempt, one session, one chargeable page.
    expect(l.operations.filter((o) => o.state === "open")).toHaveLength(1);
  });

  it("blocks a Checkout attempt while the sweep is charging the same invoice", async () => {
    const l = ledger();
    await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "autocharge",
      idempotencyKey: "autocharge:inv-1:1",
      amountCents: 17000,
    });

    const checkout = await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: checkoutKeyFor("inv-1", 17000, 0),
      amountCents: 17000,
    });

    expect(checkout.outcome).toBe("blocked");
    expect(checkout.channel).toBe("autocharge");
  });

  it("blocks the sweep while a customer has Checkout open", async () => {
    // The mirror image, and the one Stripe's idempotency key cannot catch:
    // a different channel means a different key.
    const l = ledger();
    await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: checkoutKeyFor("inv-1", 17000, 0),
      amountCents: 17000,
    });

    const sweep = await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "autocharge",
      idempotencyKey: "autocharge:inv-1:1",
      amountCents: 17000,
    });

    expect(sweep.outcome).toBe("blocked");
    expect(sweep.channel).toBe("checkout");
  });

  it("does not start a fresh attempt for a key that has already been used", async () => {
    // Repeated submissions of the same form after the first one finished.
    const l = ledger();
    const key = checkoutKeyFor("inv-1", 17000, 0);
    await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: key,
      amountCents: 17000,
    });
    await l.store.resolvePaymentOperation(key, "succeeded");

    const again = await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: key,
      amountCents: 17000,
    });

    expect(again.outcome).toBe("existing");
    expect(l.operations).toHaveLength(1);
  });

  it("does not let a dead process block an invoice for ever", async () => {
    let clock = Date.now();
    const l = ledger(() => clock);
    await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: "checkout:inv-1:17000:0",
      amountCents: 17000,
    });

    clock += 3_600_000;

    const later = await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "autocharge",
      idempotencyKey: "autocharge:inv-1:1",
      amountCents: 17000,
    });
    expect(later.outcome).toBe("started");
  });
});

describe("reconciling an attempt whose outcome we never learned", () => {
  it("records a payment Stripe took and we never wrote down", async () => {
    // Stripe succeeded, the response was lost. The invoice still reads as
    // unpaid, and without this the next attempt takes the money again.
    const l = ledger();
    await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: "checkout:inv-1:17000:0",
      amountCents: 17000,
    });
    await l.store.attachPaymentOperation({
      idempotencyKey: "checkout:inv-1:17000:0",
      stripeObjectKind: "checkout_session",
      stripeObjectId: "cs_1",
    });

    const look = vi.spyOn(gateway, "lookUpCheckoutSession").mockResolvedValue({
      state: "paid",
      paymentIntentId: "pi_1",
      amountCents: 17000,
      chargeId: "ch_1",
    });

    const result = await reconcileInvoiceCollection(l.store, "inv-1");

    expect(result.state).toBe("settled");
    expect(result.recoveredPayment).toBe(true);
    expect(l.payments).toEqual([{ intent: "pi_1", amountCents: 17000 }]);
    expect(l.operations[0]?.state).toBe("succeeded");
    look.mockRestore();
  });

  it("does not double-record a payment the webhook already applied", async () => {
    const l = ledger();
    await l.store.recordPayment({
      invoiceId: "inv-1",
      stripePaymentIntentId: "pi_1",
      amountCents: 17000,
    });
    await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: "checkout:inv-1:17000:0",
      amountCents: 17000,
    });
    await l.store.attachPaymentOperation({
      idempotencyKey: "checkout:inv-1:17000:0",
      stripeObjectKind: "checkout_session",
      stripeObjectId: "cs_1",
    });

    const look = vi.spyOn(gateway, "lookUpCheckoutSession").mockResolvedValue({
      state: "paid",
      paymentIntentId: "pi_1",
      amountCents: 17000,
      chargeId: null,
    });

    const result = await reconcileInvoiceCollection(l.store, "inv-1");

    expect(result.state).toBe("settled");
    expect(result.recoveredPayment).toBe(false);
    expect(l.payments).toHaveLength(1);
    look.mockRestore();
  });

  it("keeps a live Checkout session alive rather than starting a second one", async () => {
    const l = ledger();
    await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: "checkout:inv-1:17000:0",
      amountCents: 17000,
    });
    await l.store.attachPaymentOperation({
      idempotencyKey: "checkout:inv-1:17000:0",
      stripeObjectKind: "checkout_session",
      stripeObjectId: "cs_1",
    });

    const look = vi.spyOn(gateway, "lookUpCheckoutSession").mockResolvedValue({
      state: "open",
      url: "https://checkout.stripe.test/cs_1",
    });

    const result = await reconcileInvoiceCollection(l.store, "inv-1");

    expect(result.state).toBe("in_flight");
    expect(result.redirectUrl).toBe("https://checkout.stripe.test/cs_1");
    expect(l.payments).toHaveLength(0);
    look.mockRestore();
  });

  it("clears an attempt Stripe has finished with and no money moved", async () => {
    const l = ledger();
    await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: "checkout:inv-1:17000:0",
      amountCents: 17000,
    });
    await l.store.attachPaymentOperation({
      idempotencyKey: "checkout:inv-1:17000:0",
      stripeObjectKind: "checkout_session",
      stripeObjectId: "cs_1",
    });

    const look = vi.spyOn(gateway, "lookUpCheckoutSession").mockResolvedValue({
      state: "dead",
      reason: "session expired",
    });

    const result = await reconcileInvoiceCollection(l.store, "inv-1");

    expect(result.state).toBe("cleared");
    expect(l.operations[0]?.state).toBe("failed");
    look.mockRestore();
  });

  it("refuses to treat an unreachable Stripe as permission to charge again", async () => {
    // The most dangerous case. We asked, we could not find out, and the
    // answer to that is emphatically not "assume it failed".
    const l = ledger();
    await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "autocharge",
      idempotencyKey: "autocharge:inv-1:1",
      amountCents: 17000,
    });
    await l.store.attachPaymentOperation({
      idempotencyKey: "autocharge:inv-1:1",
      stripeObjectKind: "payment_intent",
      stripeObjectId: "pi_1",
    });

    const look = vi
      .spyOn(gateway, "lookUpPaymentIntent")
      .mockRejectedValue(new Error("connection error"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reconcileInvoiceCollection(l.store, "inv-1");

    expect(result.state).toBe("in_flight");
    expect(l.operations[0]?.state).toBe("open");
    expect(l.payments).toHaveLength(0);
    look.mockRestore();
    error.mockRestore();
  });

  it("reports nothing outstanding when no attempt is open", async () => {
    const l = ledger();
    expect((await reconcileInvoiceCollection(l.store, "inv-1")).state).toBe("cleared");
  });

  it("does not go to Stripe for an attempt that never reached it", async () => {
    // Row written, process died before the Stripe call. No money can have
    // moved, and there is no object to ask about.
    const l = ledger();
    await l.store.beginPaymentOperation({
      invoiceId: "inv-1",
      channel: "checkout",
      idempotencyKey: "checkout:inv-1:17000:0",
      amountCents: 17000,
    });

    const look = vi.spyOn(gateway, "lookUpCheckoutSession");
    const result = await reconcileInvoiceCollection(l.store, "inv-1");

    expect(result.state).toBe("cleared");
    expect(look).not.toHaveBeenCalled();
    look.mockRestore();
  });
});
