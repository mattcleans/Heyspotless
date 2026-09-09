import "server-only";

import { getStripe } from "../stripe/client";
import type { Customer } from "../data/types";
import { BillingError } from "./types";

/**
 * Every call this app makes TO Stripe, in one place.
 *
 * Routes stay thin and testable-by-reading: they authenticate, ask the pure
 * engine what should happen, call one function here, and record the result.
 * Nothing else in the codebase imports the Stripe client.
 */

/** Metadata key that ties a Stripe object back to our invoice. Read by events.ts. */
const INVOICE_KEY = "invoice_id";

/**
 * Find or create the Stripe customer for one of ours.
 *
 * Returns the id; the caller persists it. Idempotent by our own customer id, so
 * two tabs clicking "save a card" at once cannot produce two Stripe customers
 * and split one person's saved cards across them.
 */
export async function ensureStripeCustomer(customer: Customer): Promise<string> {
  if (customer.stripeCustomerId) return customer.stripeCustomerId;

  const stripe = getStripe();
  const created = await stripe.customers.create(
    {
      name: `${customer.firstName} ${customer.lastName}`.trim(),
      email: customer.email ?? undefined,
      phone: customer.phone ?? undefined,
      metadata: { spotless_customer_id: customer.id },
    },
    { idempotencyKey: `customer:${customer.id}` },
  );
  return created.id;
}

/**
 * A hosted Checkout page for one invoice.
 *
 * The amount is passed as a single ad-hoc line item rather than a price object:
 * what is owed is the invoice's balance at this moment, which is not a catalogue
 * price and must not be cached as one.
 */
export async function createCheckoutSession(args: {
  invoiceId: string;
  stripeCustomerId: string;
  amountCents: number;
  tipCents: number;
  description: string;
  origin: string;
  /** Keep the card for auto-charge. Only ever true when the customer asked. */
  saveCard: boolean;
}): Promise<{ id: string; url: string }> {
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: args.stripeCustomerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: args.amountCents,
          product_data: { name: args.description },
        },
      },
    ],
    // Read back by events.ts. The tie to our data is always this, never the amount.
    metadata: { [INVOICE_KEY]: args.invoiceId, tip_cents: String(args.tipCents) },
    payment_intent_data: {
      metadata: { [INVOICE_KEY]: args.invoiceId, tip_cents: String(args.tipCents) },
      setup_future_usage: args.saveCard ? "off_session" : undefined,
    },
    success_url: `${args.origin}/customer?paid=${args.invoiceId}`,
    cancel_url: `${args.origin}/customer?canceled=${args.invoiceId}`,
  });

  if (!session.url) {
    throw new BillingError("Stripe returned a checkout session with no URL");
  }
  return { id: session.id, url: session.url };
}

/**
 * A Checkout page in setup mode: collects a card and attaches it, taking no
 * money. The saved card arrives back as a `payment_method.attached` webhook.
 */
export async function createSetupSession(args: {
  stripeCustomerId: string;
  origin: string;
}): Promise<{ id: string; url: string }> {
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: args.stripeCustomerId,
    success_url: `${args.origin}/customer?card=saved`,
    cancel_url: `${args.origin}/customer?card=canceled`,
  });

  if (!session.url) {
    throw new BillingError("Stripe returned a setup session with no URL");
  }
  return { id: session.id, url: session.url };
}

/**
 * Charge a saved card with nobody present.
 *
 * `off_session: true` is the declaration that the customer is not here to
 * authenticate, which is what makes their bank treat this as a merchant-
 * initiated transaction against the mandate taken when the card was saved.
 * The idempotency key comes from autocharge.ts and is deterministic in
 * (invoice, attempt), so a re-run of a sweep that died mid-flight returns the
 * original charge instead of making a second one.
 */
export async function chargeOffSession(args: {
  invoiceId: string;
  stripeCustomerId: string;
  paymentMethodId: string;
  amountCents: number;
  idempotencyKey: string;
  description: string;
}): Promise<{ status: string; paymentIntentId: string; chargeId: string | null }> {
  const stripe = getStripe();

  const intent = await stripe.paymentIntents.create(
    {
      amount: args.amountCents,
      currency: "usd",
      customer: args.stripeCustomerId,
      payment_method: args.paymentMethodId,
      off_session: true,
      confirm: true,
      description: args.description,
      metadata: { [INVOICE_KEY]: args.invoiceId },
    },
    { idempotencyKey: args.idempotencyKey },
  );

  return {
    status: intent.status,
    paymentIntentId: intent.id,
    chargeId: typeof intent.latest_charge === "string" ? intent.latest_charge : null,
  };
}

/** Refund against a payment intent. The webhook records it; this only asks. */
export async function refundPaymentIntent(args: {
  paymentIntentId: string;
  amountCents: number;
  reason: string | null;
}): Promise<{ id: string; status: string | null }> {
  const stripe = getStripe();

  const refund = await stripe.refunds.create({
    payment_intent: args.paymentIntentId,
    amount: args.amountCents,
    metadata: args.reason ? { reason: args.reason } : undefined,
  });

  return { id: refund.id, status: refund.status };
}
