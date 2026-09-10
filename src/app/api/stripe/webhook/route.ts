import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { type BillingTransition, type StripeEventLike, toTransition } from "@/lib/billing/events";
import { getStripe } from "@/lib/stripe/client";
import { isBillingEnabled, requireWebhookSecret, stripeWebhookSecret } from "@/lib/stripe/env";

/**
 * The Stripe webhook. Everything that settles an invoice arrives here.
 *
 * Node runtime, because signature verification needs the RAW request body and
 * node crypto. Reading it any other way — `request.json()`, a body parser, a
 * middleware that touches it — re-serialises the bytes and every signature
 * fails, which is the classic and very confusing way to break this endpoint.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isBillingEnabled() || !stripeWebhookSecret()) {
    // 503 rather than 404: Stripe should retry once billing is switched on,
    // and an operator reading the dashboard should see "not ready", not "gone".
    return NextResponse.json({ error: "billing is not enabled" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing stripe-signature" }, { status: 400 });
  }

  const rawBody = await request.text();

  let event: StripeEventLike;
  try {
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      requireWebhookSecret(),
    ) as unknown as StripeEventLike;
  } catch {
    // Never echo the reason. An unverified body is an untrusted body, and a
    // precise error here is a hint to whoever is guessing at the secret.
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const store = new BillingStore(createAdminClient());

  // Claim before doing anything. Stripe delivers at least once and retries for
  // three days, so the second delivery of a settled payment must be a no-op.
  const claimed = await store.claimEvent(event.id, event.type, safeParse(rawBody));
  if (!claimed) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    const transition = toTransition(event);
    const outcome = await apply(store, transition);
    await store.finishEvent(event.id, outcome);
    return NextResponse.json({ received: true, outcome });
  } catch (error) {
    // Give the claim back, THEN ask for a retry. Holding it would make the
    // retry look like a duplicate and the payment would never be applied.
    await store.releaseEvent(event.id).catch(() => {});
    console.error(`stripe webhook ${event.type} (${event.id}) failed`, error);
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}

/**
 * Execute a transition. The decision of what a given event means was already
 * made, purely, in events.ts; this only writes.
 */
async function apply(store: BillingStore, transition: BillingTransition): Promise<string> {
  switch (transition.kind) {
    case "payment_succeeded": {
      const paymentId = await store.recordPayment({
        invoiceId: transition.invoiceId,
        amountCents: transition.amountCents,
        tipCents: transition.tipCents,
        stripePaymentIntentId: transition.paymentIntentId,
        method: "card",
      });
      // A null id means the SQL function found this capture already recorded,
      // which is a normal outcome, not a failure.
      return paymentId ? "applied" : "already_recorded";
    }

    case "payment_failed":
      await store.recordPaymentFailure(transition.invoiceId, transition.failureMessage);
      return "applied";

    case "card_saved": {
      const customerId = await store.findCustomerIdByStripeId(transition.stripeCustomerId);
      if (!customerId) return "ignored_unknown_customer";
      const isDefault = await store.saveCard(customerId, {
        paymentMethodId: transition.paymentMethodId,
        brand: transition.brand,
        last4: transition.last4,
        expMonth: transition.expMonth,
        expYear: transition.expYear,
      });
      // Recorded on the event so the outcome of a replay is legible in
      // `stripe_events` — "applied_default" on the first delivery and on every
      // redelivery of the default card, "applied_secondary" for the others.
      return isDefault ? "applied_default" : "applied_secondary";
    }

    case "card_detached": {
      const promoted = await store.detachCard(transition.paymentMethodId);
      // Whether a successor was found is the interesting half: no successor
      // means autopay has been suspended, which someone may need to chase.
      return promoted ? "applied_promoted" : "applied_no_card_left";
    }

    case "refund_succeeded": {
      if (!transition.paymentIntentId) return "ignored_no_payment_intent";
      const refundId = await store.recordRefund({
        stripePaymentIntentId: transition.paymentIntentId,
        amountCents: transition.amountCents,
        stripeRefundId: transition.stripeRefundId,
      });
      return refundId ? "applied" : "already_recorded";
    }

    case "ignored":
      return "ignored";
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
