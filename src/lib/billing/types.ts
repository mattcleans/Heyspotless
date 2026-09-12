/**
 * Billing vocabulary, shared by the engine, the repository and the routes.
 *
 * These unions mirror the Postgres enums in 0006_billing.sql exactly. They are
 * written out rather than generated for the same reason data/types.ts is: a
 * schema change should break a named thing in one file, not resolve to `string`
 * three layers up.
 */

export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";

export type PaymentStatus =
  | "requires_payment"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

export type RefundStatus = "pending" | "succeeded" | "failed" | "canceled";

/**
 * What a refund means for what is owed, and what it says about the clean.
 *
 * Two questions, not one. Giving money back and deciding it is owed again
 * are different acts — that is the 0011 distinction. On top of it, 0013 adds:
 * a refund also says something about whether the WORK was the problem, and a
 * marketplace that records every refund as generosity can never see its own
 * service failures.
 *
 *   unattributed   nobody said why. Fully credited, never re-collected, and
 *                  split 50/50 between service failure and goodwill so the
 *                  quality figure is neither zero nor invented. The DEFAULT,
 *                  including for refunds issued from the Stripe dashboard.
 *   service_refund someone looked and the clean was the problem. Fully
 *                  credited; attributed undiluted, because this is the
 *                  number that should drive quality work.
 *   goodwill       the work was fine and we chose to give something back.
 *                  Fully credited.
 *   overpayment    returning money never owed; capped at what was overpaid.
 *   correction     still owed, taken the wrong way. Deliberately collectible.
 *   dispute        restores the balance and PAUSES automatic collection.
 */
export type RefundKind =
  | "unattributed"
  | "service_refund"
  | "goodwill"
  | "overpayment"
  | "correction"
  | "dispute";

export const REFUND_KINDS: readonly RefundKind[] = [
  "unattributed",
  "service_refund",
  "goodwill",
  "overpayment",
  "correction",
  "dispute",
];

/** What a credit is for. Same money effect; different story. */
export type AdjustmentCategory = "service_refund" | "goodwill" | "discount" | "correction";

/**
 * How an unattributed refund is attributed, in the absence of anyone saying.
 * A stated default, not a measurement — mirrors unattributed_service_share()
 * in 0013, and the two are asserted against the same cases.
 */
export const UNATTRIBUTED_SERVICE_SHARE = 0.5;

/**
 * The split, in whole cents. The odd cent goes to goodwill: better to
 * understate a clean's failures than overstate them, since that figure is
 * what quality work is prioritised from.
 */
export function splitUnattributedRefund(amountCents: number): {
  serviceRefundCents: number;
  goodwillCents: number;
} {
  const serviceRefundCents = Math.floor(amountCents * UNATTRIBUTED_SERVICE_SHARE);
  return { serviceRefundCents, goodwillCents: amountCents - serviceRefundCents };
}

export function restoresCollectibleBalance(kind: RefundKind): boolean {
  return kind === "correction" || kind === "dispute";
}

/** Whether this kind raises a credit, so the money can never be re-collected. */
export function raisesCredit(kind: RefundKind): boolean {
  return kind === "unattributed" || kind === "service_refund" || kind === "goodwill";
}

/**
 * The six numbers that describe what an invoice is worth. Everything in
 * amounts.ts is a function of these and nothing else, which is what lets the
 * money rules be tested without a database or a Stripe account.
 */
export interface InvoiceAmounts {
  subtotalCents: number;
  tipCents: number;
  totalCents: number;
  /** Gross successfully captured, before refunds. */
  amountPaidCents: number;
  /** Gross refunded. Never exceeds amountPaidCents (enforced in 0006). */
  refundedCents: number;
  /**
   * Written off and not to be collected — a goodwill refund's other half, or
   * a discount agreed after the fact.
   *
   * This is the number that separates "we gave money back" from "it is owed
   * again". Without it a refund could only ever mean the second.
   */
  creditCents: number;
}

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}
