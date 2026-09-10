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
 * What a refund means for what is owed — the distinction 0006 did not make.
 *
 * Giving money back and deciding it is owed again are different acts, and
 * collapsing them meant a goodwill gesture turned into a fresh charge on the
 * customer's card. See 0011 for the policy in full.
 *
 *   goodwill     the work stands, the money goes back as a gesture, and a
 *                matching credit stops it becoming collectible. The DEFAULT,
 *                including for refunds issued from the Stripe dashboard,
 *                because a refund of unknown intent must never bill anyone.
 *   overpayment  returning money that was never owed.
 *   correction   taken the wrong way, still owed; deliberately collectible.
 *   dispute      restores the balance and PAUSES automatic collection.
 */
export type RefundKind = "goodwill" | "overpayment" | "correction" | "dispute";

export const REFUND_KINDS: readonly RefundKind[] = [
  "goodwill",
  "overpayment",
  "correction",
  "dispute",
];

/** Whether a refund of this kind leaves the invoice collectible again. */
export function restoresCollectibleBalance(kind: RefundKind): boolean {
  return kind === "correction" || kind === "dispute";
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
