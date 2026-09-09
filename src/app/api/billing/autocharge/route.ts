import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { type AutochargeDecision, nextAttemptAfter, planSweep } from "@/lib/billing/autocharge";
import { chargeOffSession } from "@/lib/billing/gateway";
import { cronSecretMatches, isBillingEnabled } from "@/lib/stripe/env";

/**
 * The auto-charge sweep. Runs on a schedule; charges every card that is due.
 *
 * The endpoint is guarded by CRON_SECRET rather than a session, because it runs
 * with no user. Phase 06's automation engine runs on the same schedule
 * mechanism and reuses the same guard.
 *
 * This route decides nothing. `planSweep` returns what should happen and this
 * executes it, so the rules about consent, backoff and giving up are unit
 * tested in autocharge.test.ts rather than reasoned about here.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Belt and braces against a slow sweep being started twice by the scheduler. */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const presented =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;

  if (!cronSecretMatches(presented)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "billing is not enabled" }, { status: 503 });
  }

  const store = new BillingStore(createAdminClient());
  const now = new Date();

  const candidates = await store.listAutochargeCandidates();
  const decisions = planSweep(candidates, now);

  // Stripe customer ids, needed to charge, are not on the candidate shape —
  // the decision does not depend on them, so they are fetched only for the
  // invoices actually being charged.
  const charging = decisions.filter((d): d is Extract<AutochargeDecision, { action: "charge" }> =>
    d.action === "charge",
  );
  const stripeIds = await stripeCustomerIds(store, charging.map((d) => d.customerId));

  const result = { charged: 0, failed: 0, skipped: 0, escalated: 0, unchargeable: 0 };

  for (const decision of decisions) {
    if (decision.action === "skip") {
      result.skipped += 1;
      continue;
    }

    if (decision.action === "escalate") {
      // Attempts are spent. Left overdue with its last error intact so a person
      // picks it up; nothing further is charged automatically.
      result.escalated += 1;
      continue;
    }

    const stripeCustomerId = stripeIds.get(decision.customerId);
    if (!stripeCustomerId) {
      result.unchargeable += 1;
      continue;
    }

    try {
      const charge = await chargeOffSession({
        invoiceId: decision.invoiceId,
        stripeCustomerId,
        paymentMethodId: decision.paymentMethodId,
        amountCents: decision.amountCents,
        idempotencyKey: decision.idempotencyKey,
        description: `Hey Spotless — invoice ${decision.invoiceId.slice(0, 8)}`,
      });

      if (charge.status === "succeeded") {
        // Recorded here as well as in the webhook. Both go through
        // record_payment, which is idempotent on the payment intent, so
        // whichever arrives second is a no-op.
        await store.recordPayment({
          invoiceId: decision.invoiceId,
          amountCents: decision.amountCents,
          stripePaymentIntentId: charge.paymentIntentId,
          stripeChargeId: charge.chargeId,
          idempotencyKey: decision.idempotencyKey,
          isAutocharge: true,
          method: "card",
        });
        result.charged += 1;
      } else {
        // Anything not immediately succeeded — most often a card wanting
        // authentication the customer is not present to give — spends the
        // attempt and waits for the webhook to say how it ended.
        await store.recordAutochargeFailure(
          decision.invoiceId,
          `payment intent ${charge.status}`,
          nextAttemptAfter(decision.attempt, now),
        );
        result.failed += 1;
      }
    } catch (error) {
      await store.recordAutochargeFailure(
        decision.invoiceId,
        messageOf(error),
        nextAttemptAfter(decision.attempt, now),
      );
      result.failed += 1;
    }
  }

  return NextResponse.json({ swept: decisions.length, ...result });
}

async function stripeCustomerIds(
  store: BillingStore,
  customerIds: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const id of new Set(customerIds)) {
    const stripeId = await store.getStripeCustomerId(id);
    if (stripeId) found.set(id, stripeId);
  }
  return found;
}

/**
 * Stripe's card errors carry the decline reason on the error object. It is the
 * only part worth storing — it is what the customer is told and what decides
 * whether retrying is pointless.
 */
function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message.slice(0, 500);
  }
  return "charge failed";
}
