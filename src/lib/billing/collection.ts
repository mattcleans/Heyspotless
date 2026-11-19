import "server-only";

import type { BillingStore } from "./store";
import type { PaymentOperation } from "./store";
import { lookUpCheckoutSession, lookUpPaymentIntent, type CollectionOutcome } from "./gateway";
import { stripeKeyMode } from "@/lib/stripe/env";

export const TEST_MODE_ATTEMPT_CLOSED =
  "test-mode Checkout session closed under live keys; test payments never move real money";

/**
 * Making sure an obligation is collected at most once.
 *
 * Two things had to be true and neither was.
 *
 * The first is that a collection attempt has to be VISIBLE while it is
 * happening. Checkout created a session and returned a URL; the sweep created
 * a payment intent. Until the webhook arrived there was no record, so anyone
 * else looking at the invoice saw an unpaid invoice and started a second
 * attempt — a second tab, a second click, or the nightly sweep landing on an
 * invoice a customer was in the middle of paying. `payment_operations` (0012)
 * is that record, written before Stripe is called.
 *
 * The second is that "we do not know what happened" has to be distinguished
 * from "it failed". If Stripe succeeded but the response was lost, or the
 * process died before the write, the invoice still read as unpaid and the
 * next attempt took the same money again. The answer is not a cleverer retry;
 * it is to go and ASK, which is what `reconcile` does. Nothing here charges
 * anything — every Stripe call it makes is a read.
 */

export type ReconciledState = "settled" | "in_flight" | "cleared";

export interface Reconciliation {
  state: ReconciledState;
  /** The attempt that is still live, when `in_flight`. */
  operation: PaymentOperation | null;
  /** Where to send a customer who is mid-Checkout, when there is somewhere. */
  redirectUrl: string | null;
  /** True when this reconciliation recorded a payment nobody had recorded. */
  recoveredPayment: boolean;
  /** No provider receipt can be confirmed; a person must review before retry. */
  reviewRequired?: boolean;
}

/**
 * Bring an invoice's outstanding collection attempt up to date before anyone
 * starts another one.
 *
 *   "settled"   — Stripe took the money; it is now recorded here. Do not
 *                 collect again.
 *   "in_flight" — an attempt is genuinely still live. Join it or refuse; do
 *                 not start a second one.
 *   "cleared"   — nothing is outstanding. Collecting is safe.
 */
export async function reconcileInvoiceCollection(
  store: BillingStore,
  invoiceId: string,
): Promise<Reconciliation> {
  const operation = await store.openPaymentOperation(invoiceId);
  if (!operation) {
    return { state: "cleared", operation: null, redirectUrl: null, recoveredPayment: false };
  }
  if (!operation.stripeObjectId) {
    // The provider request may have succeeded before its response was saved.
    return { state: "in_flight", operation, redirectUrl: null, recoveredPayment: false, reviewRequired: true };
  }

  // A test-mode session cannot be looked up with live keys, and nothing in it
  // can be real money, so it would otherwise block this invoice permanently
  // after the switch to live. Only this direction is safe: a live session seen
  // under test keys may hold real money and must stay open until it is checked
  // in live mode. Payment intent ids carry no mode prefix, so they never take
  // this path.
  if (
    operation.stripeObjectKind === "checkout_session" &&
    operation.stripeObjectId.startsWith("cs_test_") &&
    stripeKeyMode() === "live"
  ) {
    await store.resolvePaymentOperation(operation.idempotencyKey, "failed", TEST_MODE_ATTEMPT_CLOSED);
    return { state: "cleared", operation: null, redirectUrl: null, recoveredPayment: false };
  }

  let outcome: CollectionOutcome;
  try {
    outcome =
      operation.stripeObjectKind === "payment_intent"
        ? await lookUpPaymentIntent(operation.stripeObjectId)
        : await lookUpCheckoutSession(operation.stripeObjectId);
  } catch (error) {
    // Stripe is unreachable. That is emphatically NOT permission to charge
    // again — an unknown outcome stays unknown, and the attempt stays open.
    console.error(`could not reconcile ${operation.stripeObjectId}`, error);
    return {
      state: "in_flight",
      operation,
      redirectUrl: null,
      recoveredPayment: false,
      reviewRequired: true,
    };
  }

  if (outcome.state === "paid") {
    // THE RECOVERY. Stripe took the money and we never wrote it down —
    // a lost response, a process killed mid-write, a webhook that has not
    // landed. record_payment is idempotent on the payment intent, so doing
    // this alongside the webhook is safe; whichever arrives second is a no-op.
    const paymentId = await store.recordPayment({
      invoiceId,
      amountCents: outcome.amountCents,
      tipCents: outcome.tipCents,
      stripePaymentIntentId: outcome.paymentIntentId,
      stripeChargeId: outcome.chargeId,
      method: "card",
    });
    await store.resolvePaymentOperation(operation.idempotencyKey, "succeeded");

    return {
      state: "settled",
      operation,
      redirectUrl: null,
      recoveredPayment: paymentId !== null,
    };
  }

  if (outcome.state === "open") {
    return {
      state: "in_flight",
      operation,
      redirectUrl: outcome.url,
      recoveredPayment: false,
    };
  }

  // Stripe is finished with it and no money moved. Now — and only now — it is
  // safe to say this attempt failed and let another one start.
  await store.resolvePaymentOperation(operation.idempotencyKey, "failed", outcome.reason);
  return { state: "cleared", operation: null, redirectUrl: null, recoveredPayment: false };
}

/**
 * The key for a Checkout attempt.
 *
 * Deterministic in (invoice, what is owed, tip), so two tabs asking to settle
 * the same balance produce the SAME key and collapse into one session rather
 * than two chargeable pages. It changes once the balance does, so a genuine
 * second payment against a part-paid invoice is a genuinely new attempt.
 */
export function checkoutKeyFor(invoiceId: string, balanceCents: number, tipCents: number): string {
  return `checkout:${invoiceId}:${balanceCents}:${tipCents}`;
}
