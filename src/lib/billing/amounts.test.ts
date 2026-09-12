import { describe, expect, it } from "vitest";
import {
  MAX_TIP_FRACTION_OF_SUBTOTAL,
  applyPayment,
  applyRefund,
  balanceCents,
  chargeableCents,
  collectibleTotalCents,
  derivedStatus,
  isSettled,
  netPaidCents,
  refundableCents,
  withTip,
} from "./amounts";
import {
  BillingError,
  raisesCredit,
  restoresCollectibleBalance,
  splitUnattributedRefund,
  type InvoiceAmounts,
} from "./types";
import { toCalendarDate } from "../time/zone";

/**
 * The worked example throughout is a bi-weekly 2bd/2ba at $170 — the ticket the
 * build plan uses everywhere else — with a $20 tip. The same numbers are
 * asserted against the generated `balance_cents` column in
 * scripts/verify-migrations.sh, so SQL and TypeScript cannot drift apart.
 */
function invoice(overrides: Partial<InvoiceAmounts> = {}): InvoiceAmounts {
  return {
    subtotalCents: 17000,
    tipCents: 0,
    totalCents: 17000,
    amountPaidCents: 0,
    refundedCents: 0,
    creditCents: 0,
    ...overrides,
  };
}

describe("balance", () => {
  it("is the whole total before anything is paid", () => {
    expect(balanceCents(invoice())).toBe(17000);
  });

  it("is zero once paid in full", () => {
    expect(balanceCents(invoice({ amountPaidCents: 17000 }))).toBe(0);
  });

  it("is the remainder after a partial payment", () => {
    expect(balanceCents(invoice({ amountPaidCents: 5000 }))).toBe(12000);
  });

  it("is restored by a refund rather than shrinking the invoice", () => {
    const refunded = invoice({ amountPaidCents: 17000, refundedCents: 17000 });
    expect(balanceCents(refunded)).toBe(17000);
    // The revenue is still on the books, which is what job costing needs.
    expect(refunded.totalCents).toBe(17000);
    expect(netPaidCents(refunded)).toBe(0);
  });

  it("goes negative on an overpayment, and still counts as settled", () => {
    const over = invoice({ amountPaidCents: 20000 });
    expect(balanceCents(over)).toBe(-3000);
    expect(isSettled(over)).toBe(true);
  });
});

describe("tips", () => {
  it("adds to the total, not the subtotal", () => {
    const tipped = withTip(invoice(), 2000);
    expect(tipped.subtotalCents).toBe(17000);
    expect(tipped.tipCents).toBe(2000);
    expect(tipped.totalCents).toBe(19000);
    expect(balanceCents(tipped)).toBe(19000);
  });

  it("accumulates across separate tips", () => {
    expect(withTip(withTip(invoice(), 1000), 500).tipCents).toBe(1500);
  });

  it("accepts a tip of exactly the ceiling", () => {
    const ceiling = 17000 * MAX_TIP_FRACTION_OF_SUBTOTAL;
    expect(withTip(invoice(), ceiling).tipCents).toBe(ceiling);
  });

  it("rejects the fat-finger tip", () => {
    // $170.00 typed where $17.00 was meant, on a $170 clean.
    expect(() => withTip(invoice(), 170000)).toThrow(BillingError);
  });

  it("rejects a negative tip", () => {
    expect(() => withTip(invoice(), -100)).toThrow(BillingError);
  });

  it("rejects fractional cents", () => {
    expect(() => withTip(invoice(), 100.5)).toThrow(BillingError);
  });

  it("does not mutate the input", () => {
    const original = invoice();
    withTip(original, 2000);
    expect(original.tipCents).toBe(0);
    expect(original.totalCents).toBe(17000);
  });
});

describe("chargeable amount", () => {
  it("is the outstanding balance", () => {
    expect(chargeableCents(invoice({ amountPaidCents: 5000 }))).toBe(12000);
  });

  it("includes a tip added in the same transaction", () => {
    expect(chargeableCents(invoice(), 2000)).toBe(19000);
  });

  it("refuses to charge a settled invoice", () => {
    expect(() => chargeableCents(invoice({ amountPaidCents: 17000 }))).toThrow(BillingError);
  });

  it("refuses to charge an overpaid invoice", () => {
    expect(() => chargeableCents(invoice({ amountPaidCents: 20000 }))).toThrow(BillingError);
  });
});

describe("payments", () => {
  it("accumulates captured amounts", () => {
    expect(applyPayment(applyPayment(invoice(), 5000), 12000).amountPaidCents).toBe(17000);
  });

  it("rejects a zero or negative capture", () => {
    expect(() => applyPayment(invoice(), 0)).toThrow(BillingError);
    expect(() => applyPayment(invoice(), -1)).toThrow(BillingError);
  });
});

describe("refunds", () => {
  const paid = invoice({ amountPaidCents: 17000 });

  it("reports what remains refundable", () => {
    expect(refundableCents(17000, 0)).toBe(17000);
    expect(refundableCents(17000, 5000)).toBe(12000);
    expect(refundableCents(17000, 17000)).toBe(0);
  });

  it("never reports a negative refundable amount", () => {
    expect(refundableCents(17000, 20000)).toBe(0);
  });

  it("applies a partial refund", () => {
    const after = applyRefund(paid, 5000);
    expect(after.refundedCents).toBe(5000);
    expect(balanceCents(after)).toBe(5000);
    expect(netPaidCents(after)).toBe(12000);
  });

  it("allows partial refunds up to the captured total", () => {
    expect(applyRefund(applyRefund(paid, 5000), 12000).refundedCents).toBe(17000);
  });

  it("refuses to refund more than was captured", () => {
    expect(() => applyRefund(paid, 17001)).toThrow(BillingError);
    expect(() => applyRefund(applyRefund(paid, 17000), 1)).toThrow(BillingError);
  });

  it("refuses to refund an unpaid invoice", () => {
    expect(() => applyRefund(invoice(), 100)).toThrow(BillingError);
  });
});

/** A due date is a calendar day; the branded type keeps instants out. */
function day(iso: string) {
  const parsed = toCalendarDate(iso);
  if (!parsed) throw new Error(`not a calendar date: ${iso}`);
  return parsed;
}

/**
 * The case the old single rule got wrong, in the numbers from the brief.
 *
 * With `balance = total - paid + refunded` and nothing else, handing $50 back
 * as an apology made $50 collectible again — and with autopay on, the sweep
 * took it. The credit is what stops that, without touching either gross
 * figure that reporting depends on.
 */
describe("a goodwill refund", () => {
  it("keeps $120 and leaves nothing outstanding on a $170 invoice", () => {
    const paidInFull = invoice({ amountPaidCents: 17000 });
    expect(balanceCents(paidInFull)).toBe(0);

    // A goodwill refund is BOTH: cash back, and a decision not to collect it.
    const afterGoodwill = { ...paidInFull, refundedCents: 5000, creditCents: 5000 };

    expect(netPaidCents(afterGoodwill)).toBe(12000);
    expect(balanceCents(afterGoodwill)).toBe(0);
    expect(isSettled(afterGoodwill)).toBe(true);
    // Gross revenue is untouched, which is what job costing reads.
    expect(afterGoodwill.totalCents).toBe(17000);
    expect(collectibleTotalCents(afterGoodwill)).toBe(12000);
  });

  it("would have made $50 collectible again without the credit", () => {
    // The old behaviour, spelled out so the difference is not theoretical.
    const withoutCredit = { ...invoice({ amountPaidCents: 17000 }), refundedCents: 5000 };
    expect(balanceCents(withoutCredit)).toBe(5000);
    expect(chargeableCents(withoutCredit)).toBe(5000);
  });

  it("leaves nothing for the auto-charge sweep to take", () => {
    const afterGoodwill = { ...invoice({ amountPaidCents: 17000 }), refundedCents: 5000, creditCents: 5000 };
    expect(() => chargeableCents(afterGoodwill)).toThrow(BillingError);
  });

  it("does not disturb what is owed when the invoice was only part paid", () => {
    // $170 job, $100 paid, $50 back as a gesture. They owe $120 - $50 = $70.
    const partPaid = { ...invoice({ amountPaidCents: 10000 }), refundedCents: 5000, creditCents: 5000 };
    expect(balanceCents(partPaid)).toBe(7000);
    expect(netPaidCents(partPaid)).toBe(5000);
  });

  it("settles a fully refunded invoice instead of reopening it", () => {
    const fully = { ...invoice({ amountPaidCents: 17000 }), refundedCents: 17000, creditCents: 17000 };
    expect(balanceCents(fully)).toBe(0);
    expect(netPaidCents(fully)).toBe(0);
    expect(isSettled(fully)).toBe(true);
  });
});

describe("a refund that is not a gesture", () => {
  it("restores the balance when it is a correction", () => {
    // The money is still owed; it was taken the wrong way. No credit, and
    // the invoice is collectible again on purpose.
    const corrected = { ...invoice({ amountPaidCents: 17000 }), refundedCents: 17000 };
    expect(balanceCents(corrected)).toBe(17000);
    expect(chargeableCents(corrected)).toBe(17000);
  });

  it("brings an overpaid invoice back to zero rather than past it", () => {
    // $200 paid on a $170 job, $30 returned.
    const overpaid = invoice({ amountPaidCents: 20000 });
    expect(balanceCents(overpaid)).toBe(-3000);
    expect(isSettled(overpaid)).toBe(true);

    const returned = { ...overpaid, refundedCents: 3000 };
    expect(balanceCents(returned)).toBe(0);
    expect(netPaidCents(returned)).toBe(17000);
  });
});

describe("restoresCollectibleBalance", () => {
  it("says which kinds make an invoice owed again", () => {
    expect(restoresCollectibleBalance("unattributed")).toBe(false);
    expect(restoresCollectibleBalance("service_refund")).toBe(false);
    expect(restoresCollectibleBalance("goodwill")).toBe(false);
    expect(restoresCollectibleBalance("overpayment")).toBe(false);
    expect(restoresCollectibleBalance("correction")).toBe(true);
    expect(restoresCollectibleBalance("dispute")).toBe(true);
  });

  it("credits exactly the kinds that must never be re-collected", () => {
    expect(raisesCredit("unattributed")).toBe(true);
    expect(raisesCredit("service_refund")).toBe(true);
    expect(raisesCredit("goodwill")).toBe(true);
    // An overpayment return needs no credit: the balance was already
    // negative, and returning the excess brings it to zero on its own.
    expect(raisesCredit("overpayment")).toBe(false);
    expect(raisesCredit("correction")).toBe(false);
    expect(raisesCredit("dispute")).toBe(false);
  });
});

/**
 * A refund nobody explained is still fully credited — the money rule is
 * unchanged. What the split decides is only which bucket the business reads
 * it in, and that matters because recording every unexplained refund as
 * generosity would hide every clean that actually went wrong.
 */
describe("splitting an unattributed refund", () => {
  it("halves an even amount", () => {
    expect(splitUnattributedRefund(5000)).toEqual({
      serviceRefundCents: 2500,
      goodwillCents: 2500,
    });
  });

  it("gives the odd cent to goodwill, never to the service figure", () => {
    // The service-failure number drives quality work. Understating it by a
    // cent is harmless; overstating it points attention at the wrong clean.
    expect(splitUnattributedRefund(501)).toEqual({
      serviceRefundCents: 250,
      goodwillCents: 251,
    });
    expect(splitUnattributedRefund(1)).toEqual({
      serviceRefundCents: 0,
      goodwillCents: 1,
    });
  });

  it("never loses or invents a cent", () => {
    for (const amount of [1, 2, 3, 99, 100, 501, 4999, 5000, 17000, 123457]) {
      const { serviceRefundCents, goodwillCents } = splitUnattributedRefund(amount);
      expect(serviceRefundCents + goodwillCents).toBe(amount);
      expect(serviceRefundCents).toBeGreaterThanOrEqual(0);
      expect(goodwillCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("leaves nothing collectible, whatever the split", () => {
    // The whole refund is credited either way; the categories only divide it.
    const paidInFull = invoice({ amountPaidCents: 17000 });
    const { serviceRefundCents, goodwillCents } = splitUnattributedRefund(5000);
    const after = {
      ...paidInFull,
      refundedCents: 5000,
      creditCents: serviceRefundCents + goodwillCents,
    };
    expect(balanceCents(after)).toBe(0);
    expect(netPaidCents(after)).toBe(12000);
  });
});

describe("derived status", () => {
  const now = new Date("2026-09-09T12:00:00Z");
  const yesterday = day("2026-09-08");
  const today = day("2026-09-09");
  const tomorrow = day("2026-09-10");

  it("is paid once settled", () => {
    expect(
      derivedStatus(invoice({ amountPaidCents: 17000 }), { status: "sent", dueOn: yesterday }, now),
    ).toBe("paid");
  });

  it("is overdue past the due date with a balance", () => {
    expect(derivedStatus(invoice(), { status: "sent", dueOn: yesterday }, now)).toBe("overdue");
  });

  it("is not overdue on the due date itself", () => {
    expect(derivedStatus(invoice(), { status: "sent", dueOn: today }, now)).toBe("sent");
  });

  it("is still not overdue late on the due date in Dallas", () => {
    // 02:00 UTC on the 10th is 9pm on the 9th in Dallas. This is the case that
    // was wrong: comparing timestamps in a UTC process rolled the invoice to
    // overdue while the customer's own day still had three hours left in it.
    const lateEvening = new Date("2026-09-10T02:00:00Z");
    expect(derivedStatus(invoice(), { status: "sent", dueOn: today }, lateEvening)).toBe("sent");
  });

  it("turns overdue once the business day has actually rolled over", () => {
    // 06:00 UTC on the 10th is 1am on the 10th in Dallas — a new day, and now
    // the invoice really is late.
    const afterMidnightCentral = new Date("2026-09-10T06:00:00Z");
    expect(derivedStatus(invoice(), { status: "sent", dueOn: today }, afterMidnightCentral)).toBe(
      "overdue",
    );
  });

  it("is not overdue before the due date", () => {
    expect(derivedStatus(invoice(), { status: "sent", dueOn: tomorrow }, now)).toBe("sent");
  });

  it("keeps a void invoice void even when it looks paid", () => {
    expect(
      derivedStatus(
        invoice({ amountPaidCents: 17000 }),
        { status: "sent", dueOn: yesterday, voidedAt: new Date("2026-09-08T00:00:00Z") },
        now,
      ),
    ).toBe("void");
  });

  it("keeps a draft in draft even when overdue on paper", () => {
    expect(derivedStatus(invoice(), { status: "draft", dueOn: yesterday }, now)).toBe("draft");
  });
});
