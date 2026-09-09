import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AutochargeCandidate } from "./autocharge";
import type { BillingTransition } from "./events";
import { toInvoice } from "../data/mappers";

/**
 * How long an unfinished claim must sit before another delivery may take it
 * over. Comfortably above the webhook route's `maxDuration` of 60s, so a
 * handler that is merely slow is never treated as abandoned.
 */
const ABANDONED_CLAIM_MS = 5 * 60_000;

/**
 * Every write to the money tables.
 *
 * Separate from Repository on purpose: that is a read boundary for rendering
 * pages, and it has no writes at all. Money moves from exactly two places — the
 * Stripe webhook and the auto-charge sweep — and both run with no signed-in
 * user, so this takes the service-role client and every mutation goes through
 * the SQL functions in 0006, which do the increments under a row lock.
 *
 * Nothing here decides anything. The decisions are in autocharge.ts and
 * events.ts, which are pure; this only executes them.
 */
export class BillingStore {
  constructor(private readonly db: SupabaseClient) {}

  // --- webhook idempotency -------------------------------------------------

  /**
   * Claim a Stripe event, returning false if it has been seen before.
   *
   * The insert IS the lock: `stripe_events.id` is the primary key, so a
   * concurrent duplicate delivery loses the race with a unique violation rather
   * than both handlers proceeding. Postgres reports that as 23505.
   *
   * A losing insert is not automatically a duplicate, though. `releaseEvent`
   * gives the claim back when the handler THROWS, but a hard kill or a function
   * timeout leaves the row behind with `processed_at` still null — and then
   * every Stripe retry would be waved through as a duplicate and the payment
   * never applied, while Stripe holds the money. So an unfinished claim old
   * enough that no handler could still be running is taken over instead.
   */
  async claimEvent(id: string, type: string, payload: unknown): Promise<boolean> {
    const { error } = await this.db
      .from("stripe_events")
      .insert({ id, type, payload });

    if (!error) return true;
    if (error.code !== "23505") throw new Error(`claimEvent: ${error.message}`);

    return this.reclaimAbandonedEvent(id, type);
  }

  /**
   * Take over a claim whose handler died before finishing it.
   *
   * Touching `received_at` is what makes this a claim rather than a read: the
   * predicated UPDATE serialises, so a second delivery arriving alongside this
   * one re-evaluates after it commits, sees a fresh timestamp, and correctly
   * reports a duplicate. Two reclaims would be safe anyway — `record_payment`
   * is idempotent on the payment intent — but one is the point.
   */
  private async reclaimAbandonedEvent(id: string, type: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - ABANDONED_CLAIM_MS).toISOString();

    const { data, error } = await this.db
      .from("stripe_events")
      .update({ received_at: new Date().toISOString(), type })
      .eq("id", id)
      .is("processed_at", null)
      .lt("received_at", cutoff)
      .select("id");

    if (error) throw new Error(`claimEvent reclaim: ${error.message}`);
    return (data ?? []).length > 0;
  }

  /**
   * Give a claimed event back after the handler failed.
   *
   * Without this the claim would defeat the retry: we would have returned 500
   * to make Stripe redeliver, and then treated the redelivery as a duplicate
   * and skipped it, so the payment would never be applied. The row is deleted
   * rather than flagged so the retry takes the ordinary path.
   */
  async releaseEvent(id: string): Promise<void> {
    const { error } = await this.db.from("stripe_events").delete().eq("id", id);
    if (error) throw new Error(`releaseEvent: ${error.message}`);
  }

  async finishEvent(id: string, outcome: string, errorMessage?: string): Promise<void> {
    const { error } = await this.db
      .from("stripe_events")
      .update({ processed_at: new Date().toISOString(), outcome, error: errorMessage ?? null })
      .eq("id", id);
    if (error) throw new Error(`finishEvent: ${error.message}`);
  }

  // --- money ---------------------------------------------------------------

  /** Returns the new payment id, or null when this capture was already recorded. */
  async recordPayment(args: {
    invoiceId: string;
    amountCents: number;
    tipCents?: number;
    stripePaymentIntentId?: string | null;
    stripeChargeId?: string | null;
    idempotencyKey?: string | null;
    isAutocharge?: boolean;
    method?: string | null;
  }): Promise<string | null> {
    const { data, error } = await this.db.rpc("record_payment", {
      p_invoice_id: args.invoiceId,
      p_amount_cents: args.amountCents,
      p_tip_cents: args.tipCents ?? 0,
      p_stripe_payment_intent_id: args.stripePaymentIntentId ?? null,
      p_stripe_charge_id: args.stripeChargeId ?? null,
      p_idempotency_key: args.idempotencyKey ?? null,
      p_is_autocharge: args.isAutocharge ?? false,
      p_method: args.method ?? null,
    });
    if (error) throw new Error(`recordPayment: ${error.message}`);
    return typeof data === "string" ? data : null;
  }

  /** Returns the new refund id, or null when this refund was already recorded. */
  async recordRefund(args: {
    stripePaymentIntentId: string;
    amountCents: number;
    stripeRefundId?: string | null;
    requestedBy?: string | null;
    reason?: string | null;
  }): Promise<string | null> {
    const { data, error } = await this.db.rpc("record_refund", {
      p_stripe_payment_intent_id: args.stripePaymentIntentId,
      p_amount_cents: args.amountCents,
      p_stripe_refund_id: args.stripeRefundId ?? null,
      p_requested_by: args.requestedBy ?? null,
      p_reason: args.reason ?? null,
    });
    if (error) throw new Error(`recordRefund: ${error.message}`);
    return typeof data === "string" ? data : null;
  }

  async recordAutochargeFailure(
    invoiceId: string,
    errorMessage: string,
    nextAttemptAt: Date | null,
  ): Promise<void> {
    const { error } = await this.db.rpc("record_autocharge_failure", {
      p_invoice_id: invoiceId,
      p_error: errorMessage,
      p_next_attempt_at: nextAttemptAt ? nextAttemptAt.toISOString() : null,
    });
    if (error) throw new Error(`recordAutochargeFailure: ${error.message}`);
  }

  async recordPaymentFailure(invoiceId: string, message: string | null): Promise<void> {
    const { error } = await this.db
      .from("invoices")
      .update({ last_error: message })
      .eq("id", invoiceId);
    if (error) throw new Error(`recordPaymentFailure: ${error.message}`);
  }

  // --- customers and cards -------------------------------------------------

  async setStripeCustomerId(customerId: string, stripeCustomerId: string): Promise<void> {
    const { error } = await this.db
      .from("customers")
      .update({ stripe_customer_id: stripeCustomerId })
      .eq("id", customerId);
    if (error) throw new Error(`setStripeCustomerId: ${error.message}`);
  }

  async getStripeCustomerId(customerId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from("customers")
      .select("stripe_customer_id")
      .eq("id", customerId)
      .maybeSingle();
    if (error) throw new Error(`getStripeCustomerId: ${error.message}`);
    const id = (data as Record<string, unknown> | null)?.["stripe_customer_id"];
    return typeof id === "string" ? id : null;
  }

  async findCustomerIdByStripeId(stripeCustomerId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from("customers")
      .select("id")
      .eq("stripe_customer_id", stripeCustomerId)
      .maybeSingle();
    if (error) throw new Error(`findCustomerIdByStripeId: ${error.message}`);
    const id = (data as Record<string, unknown> | null)?.["id"];
    return typeof id === "string" ? id : null;
  }

  /**
   * Autopay consent. The timestamp is written with the flag and cleared when it
   * is withdrawn, because 0006 refuses a customer who is enabled without one —
   * the pair is the evidence that a charge was authorised.
   */
  async setAutopay(customerId: string, enabled: boolean): Promise<void> {
    const { error } = await this.db
      .from("customers")
      .update({
        autopay_enabled: enabled,
        autopay_authorized_at: enabled ? new Date().toISOString() : null,
      })
      .eq("id", customerId);
    if (error) throw new Error(`setAutopay: ${error.message}`);
  }

  /**
   * Mirror a card Stripe has attached. The first card a customer saves becomes
   * their default, so someone who has just added a card and switched autopay on
   * is chargeable without a second, invisible step.
   *
   * "First" means first OTHER than this one. Stripe redelivers
   * `setup_intent.succeeded`, so this runs again for cards already on file; a
   * query that counted the card itself would conclude "not first" and the upsert
   * below would write `is_default: false` over the customer's only default.
   * They would still have a saved card, autopay would still read as on, and
   * `listAutochargeCandidates` — which filters `is_default` — would quietly stop
   * charging them.
   */
  async saveCard(
    customerId: string,
    card: {
      paymentMethodId: string;
      brand: string | null;
      last4: string | null;
      expMonth: number | null;
      expYear: number | null;
    },
  ): Promise<void> {
    const existing = await this.db
      .from("payment_methods")
      .select("id")
      .eq("customer_id", customerId)
      .is("detached_at", null)
      .neq("stripe_payment_method_id", card.paymentMethodId)
      .limit(1);
    if (existing.error) throw new Error(`saveCard: ${existing.error.message}`);

    const isFirst = (existing.data ?? []).length === 0;

    const { error } = await this.db.from("payment_methods").upsert(
      {
        customer_id: customerId,
        stripe_payment_method_id: card.paymentMethodId,
        brand: card.brand,
        last4: card.last4,
        exp_month: card.expMonth,
        exp_year: card.expYear,
        is_default: isFirst,
        detached_at: null,
      },
      { onConflict: "stripe_payment_method_id" },
    );
    if (error) throw new Error(`saveCard: ${error.message}`);
  }

  /** Detached, never deleted: a past payment must still be able to name its card. */
  async detachCard(stripePaymentMethodId: string): Promise<void> {
    const { error } = await this.db
      .from("payment_methods")
      .update({ detached_at: new Date().toISOString(), is_default: false })
      .eq("stripe_payment_method_id", stripePaymentMethodId);
    if (error) throw new Error(`detachCard: ${error.message}`);
  }

  async setCheckoutSession(invoiceId: string, sessionId: string): Promise<void> {
    const { error } = await this.db
      .from("invoices")
      .update({ stripe_checkout_session_id: sessionId })
      .eq("id", invoiceId);
    if (error) throw new Error(`setCheckoutSession: ${error.message}`);
  }

  // --- the auto-charge working set ----------------------------------------

  /**
   * Everything the sweep might charge, in the shape `decide()` expects.
   *
   * The query is deliberately generous — it selects what is plausibly due and
   * lets the pure decision function reject it. Encoding the consent and backoff
   * rules into SQL as well would mean two implementations of the one rule that
   * must not be got wrong.
   */
  async listAutochargeCandidates(limit = 200): Promise<AutochargeCandidate[]> {
    const { data, error } = await this.db
      .from("invoices")
      .select(
        `id, customer_id, status, subtotal_cents, tip_cents, total_cents,
         amount_paid_cents, refunded_cents, balance_cents, due_on, issued_at,
         voided_at, attempt_count, next_attempt_at, last_error, created_at,
         customers!inner ( autopay_enabled, autopay_authorized_at )`,
      )
      .in("status", ["sent", "overdue"])
      .is("voided_at", null)
      .gt("balance_cents", 0)
      .order("due_on", { ascending: true, nullsFirst: true })
      .limit(limit);
    if (error) throw new Error(`listAutochargeCandidates: ${error.message}`);

    const invoiceRows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    if (invoiceRows.length === 0) return [];

    const customerIds = [...new Set(invoiceRows.map((r) => String(r["customer_id"])))];

    const cards = await this.db
      .from("payment_methods")
      .select("customer_id, stripe_payment_method_id")
      .in("customer_id", customerIds)
      .eq("is_default", true)
      .is("detached_at", null);
    if (cards.error) throw new Error(`listAutochargeCandidates cards: ${cards.error.message}`);

    const defaultCard = new Map<string, string>();
    for (const row of (cards.data ?? []) as Record<string, unknown>[]) {
      const customerId = row["customer_id"];
      const pm = row["stripe_payment_method_id"];
      if (typeof customerId === "string" && typeof pm === "string") defaultCard.set(customerId, pm);
    }

    return invoiceRows.map((row) => {
      const invoice = toInvoice(row);
      const customer = relation(row, "customers");
      return {
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        status: invoice.status,
        amounts: invoice.amounts,
        dueOn: invoice.dueOn,
        voidedAt: invoice.voidedAt,
        attemptCount: invoice.attemptCount,
        nextAttemptAt: invoice.nextAttemptAt,
        autopayEnabled: customer["autopay_enabled"] === true,
        autopayAuthorizedAt: parseDate(customer["autopay_authorized_at"]),
        defaultPaymentMethodId: defaultCard.get(invoice.customerId) ?? null,
      };
    });
  }
}

function relation(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = row[key];
  if (Array.isArray(v)) return (v[0] ?? {}) as Record<string, unknown>;
  if (v && typeof v === "object") return v as Record<string, unknown>;
  return {};
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
