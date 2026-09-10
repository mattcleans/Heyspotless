import "server-only";

import { randomUUID } from "node:crypto";
import type { BillingStore } from "./store";
import { type BillingTransition, type StripeEventLike, toTransition } from "./events";

/**
 * What the Stripe webhook does once the signature has been verified.
 *
 * Split out of the route so the RESPONSE behaviour — which status code Stripe
 * is given, for which state the event is in — is testable without a running
 * Next server, a Stripe key or a signed body. That behaviour is the whole
 * point of this file: the store's claim function can be perfectly correct and
 * the endpoint still lose payments if the route answers 200 to the wrong
 * outcome, which is exactly what it was doing.
 *
 * The rule, stated once:
 *
 *     Never acknowledge work that is not finished.
 *
 * Stripe treats any 2xx as "delivered, stop retrying". So a 2xx is reserved
 * for events that are DONE — either just now, or by an earlier delivery. An
 * event another handler is still working on gets a 409, because that handler
 * might yet die, and the redelivery is the only thing that would then rescue
 * it. Retrying an event that does turn out to be finished costs one wasted
 * request; not retrying one that was not costs the payment.
 */

/** What the route should send back. */
export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export interface HandleOptions {
  /**
   * Identifies this handler invocation for the lifetime of its lease. A fresh
   * value per call, not per process: two overlapping invocations inside one
   * process are two handlers, and must not be able to complete each other's
   * claims.
   */
  owner?: string;
  leaseSeconds?: number;
  /** Injected in tests; the route passes the parsed body. */
  payload?: unknown;
}

export async function handleStripeEvent(
  store: BillingStore,
  event: StripeEventLike,
  options: HandleOptions = {},
): Promise<WebhookResult> {
  const owner = options.owner ?? randomUUID();

  const claim = await store.claimEvent(
    event.id,
    event.type,
    options.payload ?? event,
    owner,
    options.leaseSeconds,
  );

  if (claim === "completed") {
    // The ordinary redelivery of an event that really is finished. This is
    // the ONLY duplicate worth acknowledging.
    return { status: 200, body: { received: true, duplicate: true } };
  }

  if (claim === "processing") {
    // Another handler holds a live lease. Ask Stripe to come back rather than
    // acknowledging on that handler's behalf — if it dies mid-write, this
    // redelivery is what saves the event. 409 is a retry to Stripe, and reads
    // correctly in the dashboard: a conflict, not a fault.
    return {
      status: 409,
      body: { received: false, status: "processing", retry: true },
    };
  }

  try {
    const outcome = await apply(store, toTransition(event));
    const finished = await store.finishEvent(event.id, owner, outcome);

    if (!finished) {
      // We lost the lease mid-flight: this handler ran long, another took the
      // event over, and that one's result is the one of record. The work we
      // did is safe — every money mutation is idempotent — but we must not
      // claim the outcome, and we must not tell Stripe we are done, because
      // the current owner has not finished.
      console.warn(
        `stripe webhook ${event.type} (${event.id}) finished after losing its lease; ` +
          `another handler owns it`,
      );
      return { status: 409, body: { received: false, status: "lease_lost", retry: true } };
    }

    return { status: 200, body: { received: true, outcome } };
  } catch (error) {
    // Give the claim back, THEN ask for a retry. Holding it would make the
    // retry wait out the whole lease for no reason.
    //
    // `releaseEvent` returning false means the lease already moved on, which
    // is not an error either: the new owner is dealing with it.
    await store
      .releaseEvent(event.id, owner, messageOf(error))
      .catch((releaseError: unknown) => {
        console.error(`stripe webhook ${event.id} could not release its claim`, releaseError);
      });

    console.error(`stripe webhook ${event.type} (${event.id}) failed`, error);
    return { status: 500, body: { error: "handler failed" } };
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
      // Close whatever collection attempt this was, by both references we
      // might hold — a Checkout attempt is recorded against the session id,
      // an auto-charge against the intent. An attempt left open blocks the
      // invoice from ever being collected again.
      await store.settlePaymentOperationByRef(transition.invoiceId, transition.collectionRef);
      await store.settlePaymentOperationByRef(transition.invoiceId, transition.paymentIntentId);

      // A null id means the SQL function found this capture already recorded,
      // which is a normal outcome, not a failure.
      return paymentId ? "applied" : "already_recorded";
    }

    case "payment_failed": {
      await store.recordPaymentFailure(transition.invoiceId, transition.failureMessage);
      // Stripe has told us this one is over, so close the attempt now rather
      // than holding the invoice until the operation's TTL runs out. This IS
      // an outcome — the case that must stay open is the one where we never
      // heard back at all.
      if (transition.paymentIntentId) {
        await store.resolvePaymentOperationByRef(
          transition.invoiceId,
          transition.paymentIntentId,
          transition.failureMessage,
        );
      }
      return "applied";
    }

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
        // A refund we did not initiate — someone pressed refund in the Stripe
        // dashboard — arrives with no stated intent. `goodwill` is the only
        // safe reading: it gives the money back without turning the invoice
        // into something the auto-charge sweep will collect again. An admin
        // who meant a correction records it through the refund route, which
        // asks.
        kind: "goodwill",
      });
      return refundId ? "applied" : "already_recorded";
    }

    case "refund_settled": {
      // Stripe changed its mind about a refund. Only a succeeded one moves
      // money; a failed one must leave the invoice exactly as it was.
      const outcome = await store.settleRefund(transition.stripeRefundId, transition.status);
      return `refund_${outcome}`;
    }

    case "ignored":
      return "ignored";
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}
