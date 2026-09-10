/**
 * Invoice arithmetic. The single definition of what is owed.
 *
 * Every one of these is a pure function of `InvoiceAmounts`, and every one has
 * a counterpart assertion in scripts/verify-migrations.sh. The database's
 * generated `balance_cents` column and `balanceCents()` below implement the
 * same expression on purpose: if they ever disagree, the database is right.
 *
 * The invariant, restated because it is the part people get wrong:
 *
 *     balance = total - amountPaid + refunded
 *
 * A refund RESTORES balance rather than shrinking the invoice. A $170 clean
 * that was paid and then fully refunded still reports $170 of revenue and
 * $170 outstanding — which is the truth, and is what a "revenue minus actual
 * labour" job-costing report needs. Netting the refund into the total instead
 * would quietly erase the job from the books.
 */

import { type InvoiceAmounts, type InvoiceStatus, BillingError } from "./types";
import {
  BUSINESS_TIME_ZONE,
  compareCalendarDates,
  todayIn,
  type CalendarDate,
} from "../time/zone";

/**
 * A tip may not exceed the work it is thanking. 100% of the subtotal is
 * generous and still catches the fat-finger — a $1,700 tip typed into a $170
 * clean is a chargeback and an awkward phone call, not a windfall.
 */
export const MAX_TIP_FRACTION_OF_SUBTOTAL = 1;

/** What the customer still owes. Negative means they have overpaid. */
export function balanceCents(amounts: InvoiceAmounts): number {
  return amounts.totalCents - amounts.amountPaidCents + amounts.refundedCents;
}

/** Captured and kept — what actually landed in the bank. */
export function netPaidCents(amounts: InvoiceAmounts): number {
  return amounts.amountPaidCents - amounts.refundedCents;
}

/** Settled when nothing is owed. Overpayment counts as settled, not as due. */
export function isSettled(amounts: InvoiceAmounts): boolean {
  return balanceCents(amounts) <= 0;
}

/**
 * The status an invoice should be in, derived rather than stored-and-drifted.
 * `draft` and `void` are decisions a person made and are never overridden here.
 */
export function derivedStatus(
  amounts: InvoiceAmounts,
  current: InvoiceStatusInput,
  now: Date = new Date(),
  timeZone: string = BUSINESS_TIME_ZONE,
): InvoiceStatus {
  if (current.status === "void" || current.voidedAt) return "void";
  if (current.status === "draft") return "draft";
  if (isSettled(amounts)) return "paid";
  if (current.dueOn && compareCalendarDates(current.dueOn, todayIn(timeZone, now)) < 0) {
    return "overdue";
  }
  return "sent";
}

export interface InvoiceStatusInput {
  status: InvoiceStatus;
  /**
   * The day it is due, as a day. Comparing it to a timestamp is what made an
   * invoice due today read as overdue from 7pm the previous evening whenever
   * the process ran in UTC — five hours before the office had even closed.
   */
  dueOn: CalendarDate | null;
  voidedAt?: Date | null;
}

/**
 * Validate a tip and fold it in. Returns fresh amounts; nothing is mutated,
 * because the caller needs both the before and the after to write an audit row.
 */
export function withTip(amounts: InvoiceAmounts, tipCents: number): InvoiceAmounts {
  assertWholeCents(tipCents, "tip");
  if (tipCents < 0) throw new BillingError("tip cannot be negative");

  const ceiling = Math.round(amounts.subtotalCents * MAX_TIP_FRACTION_OF_SUBTOTAL);
  if (tipCents > ceiling) {
    throw new BillingError(
      `tip of ${tipCents} exceeds the ${ceiling} ceiling for a ` +
        `${amounts.subtotalCents} subtotal — likely a mistyped amount`,
    );
  }

  const tip = amounts.tipCents + tipCents;
  return {
    ...amounts,
    tipCents: tip,
    totalCents: amounts.subtotalCents + tip,
  };
}

/**
 * What to charge the card: everything outstanding, plus any tip being added in
 * the same transaction. Refuses to charge nothing, because Stripe refuses too
 * and a clear error here beats an opaque one from the API.
 */
export function chargeableCents(amounts: InvoiceAmounts, tipCents = 0): number {
  const withTipApplied = tipCents === 0 ? amounts : withTip(amounts, tipCents);
  const due = balanceCents(withTipApplied);
  if (due <= 0) {
    throw new BillingError("nothing is owed on this invoice");
  }
  return due;
}

/** Record a successful capture. */
export function applyPayment(amounts: InvoiceAmounts, paidCents: number): InvoiceAmounts {
  assertWholeCents(paidCents, "payment");
  if (paidCents <= 0) throw new BillingError("a payment must be positive");
  return { ...amounts, amountPaidCents: amounts.amountPaidCents + paidCents };
}

/** How much of a captured payment is still refundable. */
export function refundableCents(paidCents: number, alreadyRefundedCents: number): number {
  return Math.max(0, paidCents - alreadyRefundedCents);
}

/**
 * Record a refund. Refusing to over-refund here as well as in the CHECK
 * constraint is deliberate: this one produces a sentence a human can act on,
 * the constraint is the guarantee that no other code path can get it wrong.
 */
export function applyRefund(amounts: InvoiceAmounts, refundCents: number): InvoiceAmounts {
  assertWholeCents(refundCents, "refund");
  if (refundCents <= 0) throw new BillingError("a refund must be positive");

  const available = refundableCents(amounts.amountPaidCents, amounts.refundedCents);
  if (refundCents > available) {
    throw new BillingError(
      `cannot refund ${refundCents}: only ${available} of ` +
        `${amounts.amountPaidCents} captured remains unrefunded`,
    );
  }
  return { ...amounts, refundedCents: amounts.refundedCents + refundCents };
}

function assertWholeCents(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new BillingError(`${label} must be an integer number of cents, got ${value}`);
  }
}
