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
 * The five numbers that describe what an invoice is worth. Everything in
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
}

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}
