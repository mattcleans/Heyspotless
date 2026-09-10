import { describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS,
  RETRY_SCHEDULE_DAYS,
  type AutochargeCandidate,
  decide,
  idempotencyKeyFor,
  nextAttemptAfter,
  planSweep,
} from "./autocharge";
import { BillingError } from "./types";
import { toCalendarDate, type CalendarDate } from "../time/zone";

const NOW = new Date("2026-09-09T12:00:00Z");

/** Due dates are calendar days. Instants are what got this wrong. */
function day(iso: string): CalendarDate {
  const parsed = toCalendarDate(iso);
  if (!parsed) throw new Error(`not a calendar date: ${iso}`);
  return parsed;
}

const YESTERDAY = day("2026-09-08");
const TODAY = day("2026-09-09");
const TOMORROW = day("2026-09-10");

/** A candidate that would be charged. Each test breaks exactly one thing. */
function candidate(overrides: Partial<AutochargeCandidate> = {}): AutochargeCandidate {
  return {
    invoiceId: "inv-1",
    customerId: "cust-1",
    status: "sent",
    amounts: {
      subtotalCents: 17000,
      tipCents: 0,
      totalCents: 17000,
      amountPaidCents: 0,
      refundedCents: 0,
      creditCents: 0,
    },
    dueOn: YESTERDAY,
    voidedAt: null,
    attemptCount: 0,
    nextAttemptAt: null,
    autopayEnabled: true,
    autopayAuthorizedAt: new Date("2026-01-01T00:00:00Z"),
    defaultPaymentMethodId: "pm_123",
    collectionInFlight: false,
    autochargePausedAt: null,
    ...overrides,
  };
}

describe("the charge decision", () => {
  it("charges the outstanding balance on a due, consented invoice", () => {
    expect(decide(candidate(), NOW)).toEqual({
      action: "charge",
      invoiceId: "inv-1",
      customerId: "cust-1",
      amountCents: 17000,
      paymentMethodId: "pm_123",
      attempt: 1,
      idempotencyKey: "autocharge:inv-1:1",
    });
  });

  it("charges only what is still owed after a part payment", () => {
    const d = decide(candidate({ amounts: { ...candidate().amounts, amountPaidCents: 5000 } }), NOW);
    expect(d).toMatchObject({ action: "charge", amountCents: 12000 });
  });

  it("charges the restored balance after a refund", () => {
    const amounts = { ...candidate().amounts, amountPaidCents: 17000, refundedCents: 17000 };
    expect(decide(candidate({ amounts }), NOW)).toMatchObject({
      action: "charge",
      amountCents: 17000,
    });
  });

  it("charges on the due date itself", () => {
    expect(decide(candidate({ dueOn: TODAY }), NOW)).toMatchObject({ action: "charge" });
  });

  it("does not charge a future-due invoice late on the previous evening", () => {
    // The early-charge case. 02:00 UTC on the 9th is 9pm on the 8th in Dallas,
    // so an invoice due on the 9th is not yet due — a UTC comparison would
    // already have taken the money.
    const lateOnTheEighth = new Date("2026-09-09T02:00:00Z");
    expect(decide(candidate({ dueOn: TODAY }), lateOnTheEighth)).toMatchObject({
      action: "skip",
      reason: "not_yet_due",
    });
  });

  it("charges once the business day has rolled over to the due date", () => {
    // 06:00 UTC on the 9th is 1am on the 9th in Dallas.
    const afterMidnightCentral = new Date("2026-09-09T06:00:00Z");
    expect(decide(candidate({ dueOn: TODAY }), afterMidnightCentral)).toMatchObject({
      action: "charge",
    });
  });

  it("charges immediately when there is no due date", () => {
    expect(decide(candidate({ dueOn: null }), NOW)).toMatchObject({ action: "charge" });
  });
});

describe("consent", () => {
  it("never charges without autopay enabled", () => {
    expect(decide(candidate({ autopayEnabled: false }), NOW)).toEqual({
      action: "skip",
      invoiceId: "inv-1",
      reason: "no_consent",
    });
  });

  it("never charges without a recorded consent timestamp", () => {
    expect(decide(candidate({ autopayAuthorizedAt: null }), NOW)).toMatchObject({
      reason: "no_consent",
    });
  });

  /**
   * The ordering guarantee: consent is checked before anything that could look
   * like a reason to charge, so no combination of state reaches the charge
   * branch without it.
   */
  it("refuses on consent even when every other signal says charge", () => {
    const overdue = candidate({
      autopayEnabled: false,
      status: "overdue",
      attemptCount: 0,
      dueOn: day("2026-01-01"),
    });
    expect(decide(overdue, NOW)).toMatchObject({ reason: "no_consent" });
  });
});

describe("skips", () => {
  it("skips a voided invoice", () => {
    expect(decide(candidate({ voidedAt: new Date("2026-09-08T00:00:00Z") }), NOW)).toMatchObject({
      reason: "voided",
    });
    expect(decide(candidate({ status: "void" }), NOW)).toMatchObject({ reason: "voided" });
  });

  it("skips a draft that was never sent", () => {
    expect(decide(candidate({ status: "draft" }), NOW)).toMatchObject({ reason: "not_sent" });
  });

  it("skips an invoice with nothing owed", () => {
    const amounts = { ...candidate().amounts, amountPaidCents: 17000 };
    expect(decide(candidate({ amounts }), NOW)).toMatchObject({ reason: "nothing_owed" });
  });

  it("skips a customer with no saved card", () => {
    expect(decide(candidate({ defaultPaymentMethodId: null }), NOW)).toMatchObject({
      reason: "no_card",
    });
  });

  it("does not charge ahead of the due date", () => {
    expect(decide(candidate({ dueOn: TOMORROW }), NOW)).toMatchObject({ reason: "not_yet_due" });
  });

  it("waits out a scheduled retry", () => {
    const nextAttemptAt = new Date(NOW.getTime() + 3_600_000);
    expect(decide(candidate({ attemptCount: 1, nextAttemptAt }), NOW)).toMatchObject({
      reason: "backing_off",
    });
  });

  it("retries once the backoff has elapsed", () => {
    const nextAttemptAt = new Date(NOW.getTime() - 1000);
    expect(decide(candidate({ attemptCount: 1, nextAttemptAt }), NOW)).toMatchObject({
      action: "charge",
      attempt: 2,
      idempotencyKey: "autocharge:inv-1:2",
    });
  });
});

describe("giving up", () => {
  it("escalates to a person once the attempts are spent", () => {
    expect(decide(candidate({ attemptCount: MAX_ATTEMPTS }), NOW)).toEqual({
      action: "escalate",
      invoiceId: "inv-1",
      customerId: "cust-1",
      attempts: MAX_ATTEMPTS,
    });
  });

  it("does not escalate an invoice that was settled in the meantime", () => {
    const amounts = { ...candidate().amounts, amountPaidCents: 17000 };
    expect(decide(candidate({ attemptCount: MAX_ATTEMPTS, amounts }), NOW)).toMatchObject({
      reason: "nothing_owed",
    });
  });
});

describe("idempotency keys", () => {
  it("are stable for the same attempt", () => {
    expect(idempotencyKeyFor("inv-1", 2)).toBe(idempotencyKeyFor("inv-1", 2));
  });

  it("differ across attempts and across invoices", () => {
    expect(idempotencyKeyFor("inv-1", 1)).not.toBe(idempotencyKeyFor("inv-1", 2));
    expect(idempotencyKeyFor("inv-1", 1)).not.toBe(idempotencyKeyFor("inv-2", 1));
  });

  it("reject a non-positive or fractional attempt", () => {
    expect(() => idempotencyKeyFor("inv-1", 0)).toThrow(BillingError);
    expect(() => idempotencyKeyFor("inv-1", 1.5)).toThrow(BillingError);
  });
});

describe("the retry schedule", () => {
  it("spreads attempts across a week", () => {
    expect(nextAttemptAfter(1, NOW)).toEqual(new Date("2026-09-10T12:00:00Z"));
    expect(nextAttemptAfter(2, NOW)).toEqual(new Date("2026-09-12T12:00:00Z"));
    expect(nextAttemptAfter(3, NOW)).toEqual(new Date("2026-09-16T12:00:00Z"));
  });

  it("stops scheduling once the attempts are spent", () => {
    expect(nextAttemptAfter(MAX_ATTEMPTS, NOW)).toBeNull();
  });

  it("has one fewer backoff step than it has attempts", () => {
    expect(RETRY_SCHEDULE_DAYS).toHaveLength(MAX_ATTEMPTS - 1);
  });
});

describe("the sweep", () => {
  it("decides each invoice independently and keeps input order", () => {
    const decisions = planSweep(
      [
        candidate({ invoiceId: "a" }),
        candidate({ invoiceId: "b", autopayEnabled: false }),
        candidate({ invoiceId: "c", attemptCount: MAX_ATTEMPTS }),
      ],
      NOW,
    );
    expect(decisions.map((d) => [d.invoiceId, d.action])).toEqual([
      ["a", "charge"],
      ["b", "skip"],
      ["c", "escalate"],
    ]);
  });

  it("issues a distinct idempotency key per invoice", () => {
    const decisions = planSweep([candidate({ invoiceId: "a" }), candidate({ invoiceId: "b" })], NOW);
    const keys = decisions.flatMap((d) => (d.action === "charge" ? [d.idempotencyKey] : []));
    expect(new Set(keys).size).toBe(2);
  });
});

describe("collecting once across channels", () => {
  /**
   * The sweep's other three defences all key on the sweep's OWN attempt.
   * None of them sees a customer sitting on a Checkout page for the same
   * invoice: a different channel means a different Stripe idempotency key,
   * so as far as Stripe is concerned the two charges are unrelated. They are
   * not — it is the same obligation, and collecting it twice is a refund
   * and an apology.
   */
  it("does not charge alongside a Checkout page the customer has open", () => {
    expect(decide(candidate({ collectionInFlight: true }), NOW)).toEqual({
      action: "skip",
      invoiceId: "inv-1",
      reason: "collection_in_flight",
    });
  });

  it("does not charge an invoice where collection has been paused", () => {
    // Set by a refund recorded as a dispute. Charging a card mid-dispute is
    // how one chargeback becomes two.
    expect(
      decide(candidate({ autochargePausedAt: new Date("2026-09-01T00:00:00Z") }), NOW),
    ).toMatchObject({ action: "skip", reason: "collection_paused" });
  });

  it("checks both before anything that looks like a reason to charge", () => {
    // Same ordering guarantee as consent: no combination of state reaches
    // the charge branch while somebody else is collecting.
    const overdueAndInFlight = candidate({
      status: "overdue",
      dueOn: day("2026-01-01"),
      attemptCount: 0,
      collectionInFlight: true,
    });
    expect(decide(overdueAndInFlight, NOW)).toMatchObject({ reason: "collection_in_flight" });
  });

  it("charges normally once the other attempt has cleared", () => {
    expect(decide(candidate({ collectionInFlight: false }), NOW)).toMatchObject({
      action: "charge",
    });
  });
});
