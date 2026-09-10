import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { type AutochargeDecision, nextAttemptAfter, planSweep } from "@/lib/billing/autocharge";
import { chargeOffSession } from "@/lib/billing/gateway";
import { reconcileInvoiceCollection } from "@/lib/billing/collection";
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

  const result = {
    charged: 0,
    failed: 0,
    skipped: 0,
    escalated: 0,
    unchargeable: 0,
    /** Attempts whose outcome we could not learn. Deliberately not "failed". */
    unresolved: 0,
    /** Payments Stripe had taken that nobody had recorded until now. */
    recovered: 0,
  };

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

    // Claim the invoice before calling Stripe. `planSweep` already skipped
    // anything with an attempt open, but the sweep and a customer pressing
    // Pay are not synchronised — this is what makes the claim atomic.
    const operation = await store.beginPaymentOperation({
      invoiceId: decision.invoiceId,
      channel: "autocharge",
      idempotencyKey: decision.idempotencyKey,
      amountCents: decision.amountCents,
      // Long enough to cover a slow authorisation, short enough that a dead
      // process does not hold the invoice until morning.
      ttlSeconds: 15 * 60,
    });

    if (operation.outcome === "blocked") {
      // Somebody started collecting between planning and now.
      result.skipped += 1;
      continue;
    }

    if (operation.outcome === "existing") {
      // This exact attempt has been made before and we never resolved it.
      // Ask Stripe what became of it rather than making it again — an
      // unknown outcome retried as though it were a decline is how the same
      // money gets taken twice.
      const reconciled = await reconcileInvoiceCollection(store, decision.invoiceId);
      if (reconciled.state === "settled") {
        if (reconciled.recoveredPayment) result.recovered += 1;
        result.charged += 1;
      } else {
        result.unresolved += 1;
      }
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

      // Written down before anything else, so a crash from here on leaves a
      // record pointing at the intent rather than nothing at all.
      await store.attachPaymentOperation({
        idempotencyKey: decision.idempotencyKey,
        stripeObjectKind: "payment_intent",
        stripeObjectId: charge.paymentIntentId,
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
        await store.resolvePaymentOperation(decision.idempotencyKey, "succeeded");
        result.charged += 1;
      } else if (UNRESOLVED_INTENT_STATUSES.has(charge.status)) {
        // Genuinely still in flight — most often a card wanting
        // authentication the customer is not present to give. The attempt
        // stays OPEN so nothing else collects this invoice while we wait,
        // and it is not counted as a failure, because it has not failed.
        result.unresolved += 1;
      } else {
        // Stripe said no. That is an outcome, and it spends an attempt.
        await store.resolvePaymentOperation(
          decision.idempotencyKey,
          "failed",
          `payment intent ${charge.status}`,
        );
        await store.recordAutochargeFailure(
          decision.invoiceId,
          `payment intent ${charge.status}`,
          nextAttemptAfter(decision.attempt, now),
        );
        result.failed += 1;
      }
    } catch (error) {
      if (isDecline(error)) {
        // A card decline is a KNOWN outcome. Resolve the attempt, spend one,
        // and schedule the next.
        await store.resolvePaymentOperation(decision.idempotencyKey, "failed", messageOf(error));
        await store.recordAutochargeFailure(
          decision.invoiceId,
          messageOf(error),
          nextAttemptAfter(decision.attempt, now),
        );
        result.failed += 1;
      } else {
        // We do NOT know what happened — a timeout, a dropped connection, a
        // 500 from Stripe. The charge may well have gone through. Leave the
        // attempt open so nothing else collects this invoice, and let the
        // next sweep reconcile it with Stripe. Treating this as a decline is
        // exactly how an invoice gets paid twice.
        console.error(`autocharge ${decision.invoiceId} outcome unknown`, error);
        result.unresolved += 1;
      }
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
 * Intent statuses that are not yet an answer. The customer's bank has not
 * finished, so the attempt stays open rather than being written off.
 */
const UNRESOLVED_INTENT_STATUSES = new Set([
  "processing",
  "requires_action",
  "requires_confirmation",
  "requires_capture",
]);

/**
 * Did Stripe TELL us this failed, or did we simply not hear back?
 *
 * The distinction is the difference between one charge and two. Stripe
 * reports a decline as a structured `card_error` / `StripeCardError` with the
 * request completed; a timeout, a socket reset or a 500 is a connection or
 * API error, and the charge behind it may well have succeeded.
 */
function isDecline(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const type = (error as { type?: unknown }).type;
  const name = (error as { name?: unknown }).name;
  return (
    type === "StripeCardError" ||
    type === "card_error" ||
    type === "StripeInvalidRequestError" ||
    name === "StripeCardError" ||
    name === "StripeInvalidRequestError"
  );
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
