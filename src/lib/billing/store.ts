import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AutochargeCandidate } from "./autocharge";
import type { BillingTransition } from "./events";
import type { RefundKind, RefundStatus } from "./types";

/** Which surface a collection attempt came from. */
export type PaymentOperationChannel = "checkout" | "autocharge";

/**
 * A collection attempt, as `begin_payment_operation` reports it.
 *
 *   "started"  — ours; call Stripe.
 *   "existing" — this exact key is already in play. Two identical tabs land
 *                here and get the SAME Stripe session, not a second one.
 *   "blocked"  — a different attempt is open on this invoice. Reconcile it
 *                before collecting again.
 */
export interface PaymentOperation {
  outcome: "started" | "existing" | "blocked";
  id: string;
  channel: PaymentOperationChannel;
  idempotencyKey: string;
  stripeObjectId: string | null;
  stripeObjectKind: "checkout_session" | "payment_intent" | null;
  redirectUrl: string | null;
  amountCents: number;
}

function toPaymentOperation(row: Record<string, unknown>): PaymentOperation {
  const text = (key: string): string | null =>
    typeof row[key] === "string" ? (row[key] as string) : null;

  return {
    outcome: (text("outcome") ?? "started") as PaymentOperation["outcome"],
    id: text("operation_id") ?? text("id") ?? "",
    channel: (text("channel") ?? "checkout") as PaymentOperationChannel,
    idempotencyKey: text("idempotency_key") ?? "",
    stripeObjectId: text("stripe_object_id"),
    stripeObjectKind: text("stripe_object_kind") as PaymentOperation["stripeObjectKind"],
    redirectUrl: text("redirect_url"),
    amountCents: typeof row["amount_cents"] === "number" ? row["amount_cents"] : 0,
  };
}
import { toInvoice } from "../data/mappers";

/**
 * What happened when we tried to claim a webhook event. See `claimEvent`.
 */
export type EventClaim = "claimed" | "completed" | "processing";

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

  // --- webhook events ------------------------------------------------------

  /**
   * Claim an event for processing, or find out why we cannot.
   *
   * Three outcomes, and the whole point of this change is that they are three
   * rather than two:
   *
   *   "claimed"    — ours. Process it, then `finishEvent`.
   *   "completed"  — already done. Acknowledge to Stripe, do nothing.
   *   "processing" — another handler holds a live lease. Do NOT acknowledge.
   *
   * The old shape returned a bare boolean, and `false` meant both "already
   * done" and "someone is working on it". The route answered 200 to both, so
   * an event whose handler then died had already been acknowledged to Stripe:
   * no retry, no payment applied, nothing anywhere saying so. Distinguishing
   * the two is the fix; the lease and the owner (0010) are how.
   */
  async claimEvent(
    id: string,
    type: string,
    payload: unknown,
    owner: string,
    leaseSeconds?: number,
  ): Promise<EventClaim> {
    const { data, error } = await this.db.rpc("claim_stripe_event", {
      p_id: id,
      p_type: type,
      p_payload: payload ?? null,
      p_owner: owner,
      p_lease_seconds: leaseSeconds ?? null,
    });
    if (error) throw new Error(`claimEvent: ${error.message}`);

    if (data === "claimed" || data === "completed" || data === "processing") return data;
    throw new Error(`claimEvent: unexpected outcome ${JSON.stringify(data)}`);
  }

  /**
   * Give a claimed event back after the handler failed, so the retry can take
   * the ordinary path.
   *
   * Returns false when we no longer hold the lease — another handler has taken
   * the event over, and clearing its claim would be actively harmful. The
   * caller should leave it alone; the new owner will finish it.
   */
  async releaseEvent(id: string, owner: string, errorMessage?: string): Promise<boolean> {
    const { data, error } = await this.db.rpc("release_stripe_event", {
      p_id: id,
      p_owner: owner,
      p_error: errorMessage ?? null,
    });
    if (error) throw new Error(`releaseEvent: ${error.message}`);
    return data === true;
  }

  /**
   * Mark an event finished. Returns false if the lease has moved on, in which
   * case this handler was too slow and its result is not the one of record.
   */
  async finishEvent(
    id: string,
    owner: string,
    outcome: string,
    errorMessage?: string,
  ): Promise<boolean> {
    const { data, error } = await this.db.rpc("finish_stripe_event", {
      p_id: id,
      p_owner: owner,
      p_outcome: outcome,
      p_error: errorMessage ?? null,
    });
    if (error) throw new Error(`finishEvent: ${error.message}`);
    return data === true;
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

  /**
   * Record a refund. Returns the new refund id, or null when this Stripe
   * refund id has already been recorded.
   *
   * `kind` is the decision that matters and it is required at the call site
   * rather than defaulted here: it is what separates giving money back from
   * deciding it is owed again. The SQL defaults it to `goodwill` for the one
   * caller that genuinely cannot know — a refund issued from the Stripe
   * dashboard — because a refund of unknown intent must never bill anyone.
   *
   * A refund recorded `pending` moves no money until `settleRefund`.
   */
  async recordRefund(args: {
    stripePaymentIntentId: string;
    amountCents: number;
    kind: RefundKind;
    status?: RefundStatus;
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
      p_kind: args.kind,
      p_status: args.status ?? "succeeded",
    });
    if (error) throw new Error(`recordRefund: ${error.message}`);
    return typeof data === "string" ? data : null;
  }

  /**
   * Tell us how a refund ended. Stripe can fail a refund days after
   * accepting it, and until this existed the money had already moved here.
   *
   * Returns what happened: the new status, "unchanged" for a replay, or
   * "unknown" for a refund we never recorded.
   */
  async settleRefund(stripeRefundId: string, status: RefundStatus): Promise<string> {
    const { data, error } = await this.db.rpc("settle_refund", {
      p_stripe_refund_id: stripeRefundId,
      p_status: status,
    });
    if (error) throw new Error(`settleRefund: ${error.message}`);
    return typeof data === "string" ? data : "unknown";
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

  // --- collection attempts -------------------------------------------------

  /**
   * Start a collection attempt, or find out why we may not.
   *
   * Written BEFORE Stripe is called. Between "Stripe has been asked for
   * money" and "we know what happened" there used to be no record at all, so
   * anything that consulted the invoice saw an unpaid invoice and started
   * again — a second Checkout tab, a repeated submission, the nightly sweep
   * landing on an invoice a customer was in the middle of paying.
   */
  async beginPaymentOperation(args: {
    invoiceId: string;
    channel: PaymentOperationChannel;
    idempotencyKey: string;
    amountCents: number;
    ttlSeconds?: number;
  }): Promise<PaymentOperation> {
    const { data, error } = await this.db.rpc("begin_payment_operation", {
      p_invoice_id: args.invoiceId,
      p_channel: args.channel,
      p_idempotency_key: args.idempotencyKey,
      p_amount_cents: args.amountCents,
      p_ttl_seconds: args.ttlSeconds ?? null,
    });
    if (error) throw new Error(`beginPaymentOperation: ${error.message}`);

    const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : null;
    if (!row) throw new Error("beginPaymentOperation: no row returned");
    return toPaymentOperation(row);
  }

  /** Record what Stripe object an attempt became, as soon as Stripe answers. */
  async attachPaymentOperation(args: {
    idempotencyKey: string;
    stripeObjectKind: "checkout_session" | "payment_intent";
    stripeObjectId: string;
    redirectUrl?: string | null;
    expiresAt?: Date | null;
  }): Promise<boolean> {
    const { data, error } = await this.db.rpc("attach_payment_operation", {
      p_idempotency_key: args.idempotencyKey,
      p_stripe_object_kind: args.stripeObjectKind,
      p_stripe_object_id: args.stripeObjectId,
      p_redirect_url: args.redirectUrl ?? null,
      p_expires_at: args.expiresAt ? args.expiresAt.toISOString() : null,
    });
    if (error) throw new Error(`attachPaymentOperation: ${error.message}`);
    return data === true;
  }

  /**
   * Close a collection attempt.
   *
   * "failed" means Stripe SAID it failed. An attempt whose outcome we could
   * not learn is "abandoned", and only after reconciling with Stripe — the
   * difference is the whole point, because retrying an unknown outcome as
   * though it were a decline is how the same money gets taken twice.
   */
  async resolvePaymentOperation(
    idempotencyKey: string,
    state: "succeeded" | "failed" | "abandoned",
    errorMessage?: string,
  ): Promise<boolean> {
    const { data, error } = await this.db.rpc("resolve_payment_operation", {
      p_idempotency_key: idempotencyKey,
      p_state: state,
      p_error: errorMessage ?? null,
    });
    if (error) throw new Error(`resolvePaymentOperation: ${error.message}`);
    return data === true;
  }

  /**
   * Close a failed attempt by the Stripe object it was made against.
   *
   * Only ever called when Stripe has told us the attempt is over. An attempt
   * whose outcome we never learned must stay open — that is what stops the
   * next collection taking the same money.
   */
  async resolvePaymentOperationByRef(
    invoiceId: string,
    ref: string,
    errorMessage?: string | null,
  ): Promise<boolean> {
    const { data, error } = await this.db
      .from("payment_operations")
      .update({
        state: "failed",
        resolved_at: new Date().toISOString(),
        last_error: errorMessage ?? null,
      })
      .eq("invoice_id", invoiceId)
      .eq("stripe_object_id", ref)
      .eq("state", "open")
      .select("id");
    if (error) throw new Error(`resolvePaymentOperationByRef: ${error.message}`);
    return (data ?? []).length > 0;
  }

  /** Close whatever attempt a settled payment belongs to, by Stripe object. */
  async settlePaymentOperationByRef(invoiceId: string, ref: string | null): Promise<boolean> {
    if (!ref) return false;
    const { data, error } = await this.db.rpc("settle_payment_operation_by_ref", {
      p_invoice_id: invoiceId,
      p_ref: ref,
    });
    if (error) throw new Error(`settlePaymentOperationByRef: ${error.message}`);
    return data === true;
  }

  /** The attempt currently open on an invoice, if any. */
  async openPaymentOperation(invoiceId: string): Promise<PaymentOperation | null> {
    const { data, error } = await this.db.rpc("open_payment_operation", {
      p_invoice_id: invoiceId,
    });
    if (error) throw new Error(`openPaymentOperation: ${error.message}`);

    const row = Array.isArray(data)
      ? (data[0] as Record<string, unknown> | undefined)
      : (data as Record<string, unknown> | null);
    if (!row || typeof row["id"] !== "string") return null;
    return toPaymentOperation({ ...row, operation_id: row["id"], outcome: "existing" });
  }

  /** Every invoice with a collection attempt open, for the sweep to avoid. */
  async invoiceIdsWithOpenCollection(invoiceIds: readonly string[]): Promise<Set<string>> {
    if (invoiceIds.length === 0) return new Set();

    const { data, error } = await this.db
      .from("payment_operations")
      .select("invoice_id, expires_at")
      .in("invoice_id", [...invoiceIds])
      .eq("state", "open");
    if (error) throw new Error(`invoiceIdsWithOpenCollection: ${error.message}`);

    const now = Date.now();
    const open = new Set<string>();
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const invoiceId = row["invoice_id"];
      const expiresAt = row["expires_at"];
      if (typeof invoiceId !== "string") continue;
      // An expired attempt is not in flight. It still blocks a NEW attempt
      // until reconciled (begin_payment_operation abandons it), but it must
      // not make the sweep skip an invoice for ever.
      if (typeof expiresAt === "string" && new Date(expiresAt).getTime() <= now) continue;
      open.add(invoiceId);
    }
    return open;
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
        // A suspension describes autopay that is on and cannot run. Switching
        // it off resolves that; switching it on is a fresh start.
        autopay_suspended_at: null,
        autopay_suspended_reason: null,
      })
      .eq("id", customerId);
    if (error) throw new Error(`setAutopay: ${error.message}`);
  }

  /**
   * Mirror a card Stripe has attached.
   *
   * The decision — whether this card becomes the default — is NOT made here.
   * It is a read-modify-write across two rows that two webhook deliveries can
   * enter at once, so it happens in `save_payment_method` (0009) under a lock
   * on the customer row.
   *
   * The previous attempt made it here, by counting the customer's other cards
   * and writing `is_default = (there are none)`. That is right with one card
   * on file and wrong with two: replaying the DEFAULT card's attach event —
   * which Stripe does routinely, for three days — found the other card, judged
   * this one "not first", and wrote `is_default = false` over the customer's
   * only default. Saved cards intact, autopay still on, and the sweep silently
   * charging nobody.
   *
   * Returns whether this card is the default after the call.
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
  ): Promise<boolean> {
    const { data, error } = await this.db.rpc("save_payment_method", {
      p_customer_id: customerId,
      p_stripe_payment_method_id: card.paymentMethodId,
      p_brand: card.brand,
      p_last4: card.last4,
      p_exp_month: card.expMonth,
      p_exp_year: card.expYear,
    });
    if (error) throw new Error(`saveCard: ${error.message}`);
    return data === true;
  }

  /**
   * Detach a card. Detached, never deleted: a past payment must still be able
   * to name the card it was taken on.
   *
   * Returns the Stripe id of whatever is the default afterwards, or null when
   * the customer has no card left. Removing the last card SUSPENDS autopay
   * rather than cancelling it — see the policy in 0009.
   */
  async detachCard(stripePaymentMethodId: string): Promise<string | null> {
    const { data, error } = await this.db.rpc("detach_payment_method", {
      p_stripe_payment_method_id: stripePaymentMethodId,
    });
    if (error) throw new Error(`detachCard: ${error.message}`);
    return typeof data === "string" ? data : null;
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
         amount_paid_cents, refunded_cents, credit_cents, balance_cents, due_on,
         issued_at, voided_at, attempt_count, next_attempt_at, last_error,
         autocharge_paused_at, autocharge_paused_reason, created_at,
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

    // Which of these a customer is already in the middle of paying. The
    // sweep must not charge alongside a Checkout page, and this is the only
    // signal that says so — Stripe's idempotency key is per-channel and sees
    // the two attempts as unrelated.
    const inFlight = await this.invoiceIdsWithOpenCollection(
      invoiceRows.map((r) => String(r["id"])),
    );

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
        collectionInFlight: inFlight.has(invoice.id),
        autochargePausedAt: parseDate(row["autocharge_paused_at"]),
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
