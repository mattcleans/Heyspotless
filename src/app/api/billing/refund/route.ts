import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { refundPaymentIntent } from "@/lib/billing/gateway";
import { isDefiniteStripeRefusal } from "@/lib/billing/stripe-errors";
import { REFUND_KINDS, type RefundStatus } from "@/lib/billing/types";
import { isBillingEnabled } from "@/lib/stripe/env";
import { formatCents } from "@/lib/money";

/**
 * Issue a refund. Admin only, and deliberately not exposed to customers.
 *
 * The role is checked here rather than left to row-level security because this
 * route writes through the service-role client, which bypasses RLS by design.
 * That makes this one of the few places in the app where the check in the
 * TypeScript IS the security boundary, so it is the first thing the handler
 * does and it fails closed.
 *
 * `kind` is REQUIRED, and there is deliberately no default. It decides
 * whether the customer ends up owing the money again, and that is not
 * something to infer from silence: a goodwill gesture and a correction are
 * the same API call and opposite outcomes. See lib/billing/types.ts.
 *
 * `requestId` is one per submitted form and becomes Stripe's idempotency
 * key, so a double click, a retry after a lost response, or two tabs
 * submitting the same form refund once. A new form gets a new id.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_REASON = 500;

export async function POST(request: NextRequest) {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Refunds are unavailable because billing is not enabled." }, { status: 503 });
  }

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "Sign in to Management." }, { status: 401 });
  if (profile.role !== "admin") {
    return NextResponse.json({ error: "Management access is required." }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Refresh the page before refunding." }, { status: 403 });
  }

  const body = await readJson(request);
  const paymentIntentId =
    typeof body["paymentIntentId"] === "string" ? body["paymentIntentId"] : null;
  const amountCents = body["amountCents"];
  const rawReason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
  const reason = rawReason ? rawReason.slice(0, MAX_REASON) : null;
  const kind = REFUND_KINDS.find((k) => k === body["kind"]) ?? null;
  const requestId = typeof body["requestId"] === "string" ? body["requestId"] : null;

  if (!paymentIntentId) {
    return NextResponse.json({ error: "Choose a payment to refund." }, { status: 400 });
  }
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return NextResponse.json({ error: "Enter a refund amount greater than zero." }, { status: 400 });
  }
  if (!kind) {
    return NextResponse.json(
      {
        error: `Choose why this refund is being made (one of ${REFUND_KINDS.join(", ")}).`,
        detail:
          "It decides whether this money becomes owed again. goodwill and " +
          "overpayment do not; correction and dispute do.",
      },
      { status: 400 },
    );
  }
  if (!requestId || !UUID.test(requestId)) {
    return NextResponse.json({ error: "Refresh the page before refunding." }, { status: 400 });
  }

  const store = new BillingStore(createAdminClient());

  let payment;
  try {
    payment = await store.paymentForIntent(paymentIntentId);
  } catch {
    return NextResponse.json({ error: "The payment could not be loaded. Refresh before refunding." }, { status: 503 });
  }
  if (!payment) {
    return NextResponse.json({ error: "That payment was not found." }, { status: 404 });
  }
  if (payment.status !== "succeeded") {
    return NextResponse.json({ error: "Only a completed payment can be refunded." }, { status: 409 });
  }
  if (amountCents > payment.refundableCents) {
    return NextResponse.json(
      {
        error:
          payment.refundableCents === 0
            ? "This payment has already been refunded in full."
            : `At most ${formatCents(payment.refundableCents)} of this payment can still be refunded.`,
      },
      { status: 409 },
    );
  }

  let refund;
  try {
    refund = await refundPaymentIntent({
      paymentIntentId,
      amountCents,
      reason,
      kind,
      idempotencyKey: `refund:${paymentIntentId}:${requestId}`,
    });
  } catch (error) {
    if (isDefiniteStripeRefusal(error)) {
      const message = error instanceof Error && error.message ? error.message : "Stripe refused the refund.";
      return NextResponse.json({ error: `Stripe refused the refund: ${message}` }, { status: 409 });
    }
    // A timeout or 5xx can follow a refund Stripe actually made. The same
    // requestId is safe to retry; a new form is not until Stripe is checked.
    console.error("refund: Stripe did not confirm", error);
    return NextResponse.json(
      {
        error:
          "Stripe did not confirm the refund. Try again from this same form, or check the payment in Stripe before starting a new one.",
        retrySafe: true,
      },
      { status: 502 },
    );
  }

  // Recorded here as well as by the charge.refunded webhook. record_refund is
  // idempotent on the Stripe refund id, so the second one is a no-op, and the
  // webhook reads the same kind from the refund's metadata if it wins.
  //
  // Stripe's own status is carried through rather than assumed: a refund can
  // come back `pending` and fail days later, and recording that as succeeded
  // would credit an invoice for money that never actually went back.
  let refundId: string | null;
  try {
    refundId = await store.recordRefund({
      stripePaymentIntentId: paymentIntentId,
      amountCents,
      kind,
      status: recordableStatus(refund.status),
      stripeRefundId: refund.id,
      requestedBy: profile.id,
      reason,
    });
  } catch (error) {
    console.error("refund: Stripe refunded but saving failed", error);
    return NextResponse.json(
      {
        error:
          "Stripe made the refund, but saving it here failed. Do not refund again; it will be recorded from Stripe's confirmation shortly.",
        stripeRefundId: refund.id,
        refunded: true,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    refundId,
    stripeRefundId: refund.id,
    status: refund.status,
    kind,
    alreadyRecorded: refundId === null,
  });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Stripe's refund status, as something we are willing to record.
 *
 * Only `succeeded` moves money now. Anything else is recorded pending and
 * settled by the `refund.updated` webhook, so a refund the issuer later
 * rejects never credited the invoice in the first place.
 */
function recordableStatus(stripeStatus: string | null): RefundStatus {
  return stripeStatus === "succeeded" ? "succeeded" : "pending";
}
