import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { refundPaymentIntent } from "@/lib/billing/gateway";
import { REFUND_KINDS, type RefundStatus } from "@/lib/billing/types";
import { isBillingEnabled } from "@/lib/stripe/env";

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
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "billing is not enabled" }, { status: 503 });
  }

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  if (profile.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await readJson(request);
  const paymentIntentId =
    typeof body["paymentIntentId"] === "string" ? body["paymentIntentId"] : null;
  const amountCents = Math.trunc(Number(body["amountCents"]));
  const reason = typeof body["reason"] === "string" ? body["reason"] : null;
  const kind = REFUND_KINDS.find((k) => k === body["kind"]) ?? null;

  if (!paymentIntentId) {
    return NextResponse.json({ error: "paymentIntentId is required" }, { status: 400 });
  }
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return NextResponse.json({ error: "amountCents must be a positive integer" }, { status: 400 });
  }
  if (!kind) {
    return NextResponse.json(
      {
        error: `kind is required and must be one of ${REFUND_KINDS.join(", ")}`,
        detail:
          "It decides whether this money becomes owed again. goodwill and " +
          "overpayment do not; correction and dispute do.",
      },
      { status: 400 },
    );
  }

  const store = new BillingStore(createAdminClient());

  const refund = await refundPaymentIntent({ paymentIntentId, amountCents, reason });

  // Recorded here as well as by the charge.refunded webhook. record_refund is
  // idempotent on the Stripe refund id, so the second one is a no-op — and
  // recording it now means the admin sees the effect without waiting.
  //
  // Stripe's own status is carried through rather than assumed: a refund can
  // come back `pending` and fail days later, and recording that as succeeded
  // would credit an invoice for money that never actually went back.
  const refundId = await store.recordRefund({
    stripePaymentIntentId: paymentIntentId,
    amountCents,
    kind,
    status: recordableStatus(refund.status),
    stripeRefundId: refund.id,
    requestedBy: profile.id,
    reason,
  });

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
