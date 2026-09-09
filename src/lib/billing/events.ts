/**
 * Stripe webhook event -> domain transition.
 *
 * Deliberately knows nothing about the Stripe SDK. It takes the decoded JSON
 * shape and returns what should happen to our own tables, so the interesting
 * half of webhook handling — which is the mapping, not the HTTP — is testable
 * with a plain object and no network, no keys and no fixtures from a library.
 *
 * Two rules this file exists to enforce:
 *
 *   * An event we do not understand is `ignored`, never an error. Stripe retries
 *     anything we fail for three days, so returning 500 on an event type we
 *     simply do not handle turns a normal account setting into a retry storm.
 *   * The tie back to our data is ALWAYS `metadata.invoice_id`, set by us when
 *     the session or intent was created. We never try to infer which invoice a
 *     payment belongs to from its amount.
 */

export interface StripeEventLike {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export type BillingTransition =
  | {
      kind: "payment_succeeded";
      invoiceId: string;
      paymentIntentId: string | null;
      amountCents: number;
      tipCents: number;
    }
  | {
      kind: "payment_failed";
      invoiceId: string;
      paymentIntentId: string | null;
      failureCode: string | null;
      failureMessage: string | null;
    }
  | {
      kind: "card_saved";
      stripeCustomerId: string;
      paymentMethodId: string;
      brand: string | null;
      last4: string | null;
      expMonth: number | null;
      expYear: number | null;
    }
  | { kind: "card_detached"; paymentMethodId: string }
  | {
      kind: "refund_succeeded";
      paymentIntentId: string | null;
      chargeId: string | null;
      amountCents: number;
      stripeRefundId: string | null;
    }
  | { kind: "ignored"; type: string; reason: string };

type Obj = Record<string, unknown>;

export function toTransition(event: StripeEventLike): BillingTransition {
  const o = event.data?.object ?? {};

  switch (event.type) {
    case "checkout.session.completed":
      return fromCheckoutSession(event.type, o);

    case "payment_intent.succeeded": {
      const invoiceId = metadataString(o, "invoice_id");
      if (!invoiceId) return ignored(event.type, "no invoice_id in metadata");
      return {
        kind: "payment_succeeded",
        invoiceId,
        paymentIntentId: str(o, "id"),
        amountCents: int(o, "amount_received") ?? int(o, "amount") ?? 0,
        tipCents: metadataInt(o, "tip_cents") ?? 0,
      };
    }

    case "payment_intent.payment_failed": {
      const invoiceId = metadataString(o, "invoice_id");
      if (!invoiceId) return ignored(event.type, "no invoice_id in metadata");
      const error = obj(o, "last_payment_error");
      return {
        kind: "payment_failed",
        invoiceId,
        paymentIntentId: str(o, "id"),
        failureCode: str(error, "code") ?? str(error, "decline_code"),
        failureMessage: str(error, "message"),
      };
    }

    case "payment_method.attached": {
      const paymentMethodId = str(o, "id");
      const stripeCustomerId = str(o, "customer");
      if (!paymentMethodId || !stripeCustomerId) {
        return ignored(event.type, "payment method is not attached to a customer");
      }
      const card = obj(o, "card");
      return {
        kind: "card_saved",
        stripeCustomerId,
        paymentMethodId,
        brand: str(card, "brand"),
        last4: str(card, "last4"),
        expMonth: int(card, "exp_month"),
        expYear: int(card, "exp_year"),
      };
    }

    case "payment_method.detached": {
      const paymentMethodId = str(o, "id");
      if (!paymentMethodId) return ignored(event.type, "no payment method id");
      return { kind: "card_detached", paymentMethodId };
    }

    case "charge.refunded":
      return fromChargeRefunded(event.type, o);

    default:
      return ignored(event.type, "unhandled event type");
  }
}

/**
 * A Checkout session in `payment` mode settled an invoice. In `setup` mode it
 * saved a card — and that is reported separately as `payment_method.attached`,
 * which carries the brand and last4 the session does not, so setup sessions are
 * intentionally ignored here rather than half-handled twice.
 */
function fromCheckoutSession(type: string, o: Obj): BillingTransition {
  const mode = str(o, "mode");
  if (mode === "setup") {
    return ignored(type, "setup mode; the card arrives as payment_method.attached");
  }
  if (str(o, "payment_status") !== "paid") {
    return ignored(type, `session completed but payment_status is ${str(o, "payment_status")}`);
  }

  const invoiceId = metadataString(o, "invoice_id");
  if (!invoiceId) return ignored(type, "no invoice_id in metadata");

  return {
    kind: "payment_succeeded",
    invoiceId,
    paymentIntentId: str(o, "payment_intent"),
    amountCents: int(o, "amount_total") ?? 0,
    tipCents: metadataInt(o, "tip_cents") ?? 0,
  };
}

/**
 * `charge.refunded` fires for partial refunds too, and the charge's cumulative
 * `amount_refunded` is NOT what we want — applying that as a delta would
 * double-count the earlier refund. The newest entry in `refunds.data` is this
 * refund, so that is what gets applied.
 */
function fromChargeRefunded(type: string, o: Obj): BillingTransition {
  const list = obj(o, "refunds");
  const data = Array.isArray(list["data"]) ? (list["data"] as unknown[]) : [];
  const latest = data.length > 0 ? (data[0] as Obj) : null;

  const amountCents = latest ? (int(latest, "amount") ?? 0) : (int(o, "amount_refunded") ?? 0);
  if (amountCents <= 0) return ignored(type, "refund carries no amount");

  return {
    kind: "refund_succeeded",
    paymentIntentId: str(o, "payment_intent"),
    chargeId: str(o, "id"),
    amountCents,
    stripeRefundId: latest ? str(latest, "id") : null,
  };
}

function ignored(type: string, reason: string): BillingTransition {
  return { kind: "ignored", type, reason };
}

// --- readers ---------------------------------------------------------------
// Same posture as data/mappers.ts: read only what is needed, coerce explicitly,
// and never assume a field is present just because the API reference lists it.

function str(o: Obj, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function int(o: Obj, key: string): number | null {
  const v = o[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Math.round(Number(v));
  }
  return null;
}

function obj(o: Obj, key: string): Obj {
  const v = o[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

function metadataString(o: Obj, key: string): string | null {
  return str(obj(o, "metadata"), key);
}

function metadataInt(o: Obj, key: string): number | null {
  return int(obj(o, "metadata"), key);
}
