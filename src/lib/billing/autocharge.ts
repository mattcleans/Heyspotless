/**
 * Auto-charge: deciding which cards to run, when, and how many times.
 *
 * Build plan phase 03. This is the piece that removes the "chase the invoice"
 * work, and it is also the piece most able to cause real damage — a double
 * charge or a card run without consent costs a customer, not just a cycle. So
 * the decision is a pure function with no Stripe client in sight, and the
 * route in app/api/billing/autocharge does nothing but execute what it returns.
 *
 * Four defences against charging twice, in depth:
 *
 *   1. `idempotencyKeyFor` is deterministic in (invoice, attempt), so the same
 *      attempt replayed is the same key, and Stripe collapses it to one charge.
 *   2. `payments.idempotency_key` is UNIQUE (0006), so a duplicated cron run
 *      cannot even record a second attempt locally.
 *   3. The sweep only ever charges the outstanding balance, so a charge that
 *      succeeded but whose webhook has not landed yet leaves nothing to take.
 *   4. `collectionInFlight` — an open payment operation (0012). The first
 *      three all key on the sweep's OWN attempt, and none of them sees a
 *      customer sitting on a Checkout page for the same invoice. A different
 *      channel means a different idempotency key, so as far as Stripe is
 *      concerned the two charges are unrelated. They are not.
 */

import { type InvoiceAmounts, BillingError } from "./types";
import { balanceCents } from "./amounts";
import {
  BUSINESS_TIME_ZONE,
  compareCalendarDates,
  todayIn,
  type CalendarDate,
} from "../time/zone";

/**
 * Four attempts, then a person looks at it. Card failures are overwhelmingly
 * either instantly retryable or not retryable at all; a fifth automated attempt
 * mostly generates issuer friction and a fifth "payment failed" email.
 */
export const MAX_ATTEMPTS = 4;

/**
 * Backoff between attempts, in days, indexed by attempts already made. Spread
 * across a week because the common recoverable cause is an empty account on
 * the wrong side of a pay cycle, not a broken card.
 */
export const RETRY_SCHEDULE_DAYS: readonly number[] = [1, 3, 7];

export type SkipReason =
  | "not_sent"
  | "voided"
  | "nothing_owed"
  | "no_consent"
  | "no_card"
  | "not_yet_due"
  | "backing_off"
  /** A customer is mid-Checkout, or a previous charge has not resolved. */
  | "collection_in_flight"
  /** A person stopped automatic collection on this invoice — see 0011. */
  | "collection_paused";

export interface AutochargeCandidate {
  invoiceId: string;
  customerId: string;
  status: "draft" | "sent" | "paid" | "overdue" | "void";
  amounts: InvoiceAmounts;
  /** The day it falls due, as a day — see the note on `Invoice.dueOn`. */
  dueOn: CalendarDate | null;
  voidedAt: Date | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  /** Consent, from the customer row. Both halves are required. */
  autopayEnabled: boolean;
  autopayAuthorizedAt: Date | null;
  /** The customer's default saved card, or null if they have none. */
  defaultPaymentMethodId: string | null;
  /**
   * A collection attempt is already open on this invoice — a Checkout page a
   * customer has in front of them, or a charge whose outcome is not known
   * yet. Charging alongside it takes the same money twice, and it is the one
   * case the Stripe idempotency key cannot catch: a different channel means
   * a different key.
   */
  collectionInFlight: boolean;
  /**
   * Automatic collection stopped by a person — currently, a refund recorded
   * as a dispute. Charging a card mid-dispute turns one chargeback into two.
   */
  autochargePausedAt: Date | null;
}

export type AutochargeDecision =
  | {
      action: "charge";
      invoiceId: string;
      customerId: string;
      amountCents: number;
      paymentMethodId: string;
      /** 1-based: the attempt this charge will be. */
      attempt: number;
      idempotencyKey: string;
    }
  | { action: "skip"; invoiceId: string; reason: SkipReason }
  | { action: "escalate"; invoiceId: string; customerId: string; attempts: number };

/**
 * Stable across retries of the same attempt, distinct across attempts. Stripe
 * treats a repeated key as the same request and returns the original result,
 * which is what makes a cron run that dies mid-sweep safe to simply run again.
 */
export function idempotencyKeyFor(invoiceId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new BillingError(`attempt must be a positive integer, got ${attempt}`);
  }
  return `autocharge:${invoiceId}:${attempt}`;
}

/**
 * When to try next after a failure. Returns null once the attempts are spent —
 * the caller escalates to a human rather than scheduling a fifth run.
 */
export function nextAttemptAfter(attemptsMade: number, from: Date): Date | null {
  if (attemptsMade >= MAX_ATTEMPTS) return null;
  const days = RETRY_SCHEDULE_DAYS[attemptsMade - 1] ?? RETRY_SCHEDULE_DAYS.at(-1) ?? 7;
  return new Date(from.getTime() + days * 86_400_000);
}

/**
 * Decide what to do with one invoice. Order matters: consent is checked before
 * anything that could look like a reason to charge, so a customer who has not
 * opted in can never reach the charge branch by any combination of state.
 */
export function decide(
  candidate: AutochargeCandidate,
  now: Date = new Date(),
  timeZone: string = BUSINESS_TIME_ZONE,
): AutochargeDecision {
  const { invoiceId, customerId } = candidate;

  if (candidate.voidedAt || candidate.status === "void") {
    return { action: "skip", invoiceId, reason: "voided" };
  }
  if (candidate.status === "draft") {
    return { action: "skip", invoiceId, reason: "not_sent" };
  }

  // Consent first, and both halves of it. 0006 makes the pair a CHECK
  // constraint; re-checking here means a hand-edited row cannot slip past.
  if (!candidate.autopayEnabled || !candidate.autopayAuthorizedAt) {
    return { action: "skip", invoiceId, reason: "no_consent" };
  }

  const owed = balanceCents(candidate.amounts);
  if (owed <= 0) {
    return { action: "skip", invoiceId, reason: "nothing_owed" };
  }

  // Checked before anything that looks like a reason to charge, for the same
  // reason consent is: no combination of state should reach the charge branch
  // while somebody else is already collecting, or while a person has said stop.
  if (candidate.autochargePausedAt) {
    return { action: "skip", invoiceId, reason: "collection_paused" };
  }
  if (candidate.collectionInFlight) {
    return { action: "skip", invoiceId, reason: "collection_in_flight" };
  }

  if (candidate.attemptCount >= MAX_ATTEMPTS) {
    return { action: "escalate", invoiceId, customerId, attempts: candidate.attemptCount };
  }

  if (!candidate.defaultPaymentMethodId) {
    return { action: "skip", invoiceId, reason: "no_card" };
  }

  // Never charge ahead of the due date, and "ahead" is decided on the business
  // calendar. Comparing timestamps in the server's zone meant a card could be
  // run the evening BEFORE the invoice was due, which is money taken early.
  if (candidate.dueOn && compareCalendarDates(candidate.dueOn, todayIn(timeZone, now)) > 0) {
    return { action: "skip", invoiceId, reason: "not_yet_due" };
  }

  // A scheduled retry that has not come round yet.
  if (candidate.nextAttemptAt && candidate.nextAttemptAt.getTime() > now.getTime()) {
    return { action: "skip", invoiceId, reason: "backing_off" };
  }

  const attempt = candidate.attemptCount + 1;
  return {
    action: "charge",
    invoiceId,
    customerId,
    amountCents: owed,
    paymentMethodId: candidate.defaultPaymentMethodId,
    attempt,
    idempotencyKey: idempotencyKeyFor(invoiceId, attempt),
  };
}

/** The whole sweep, in the order the cron endpoint should execute it. */
export function planSweep(
  candidates: readonly AutochargeCandidate[],
  now: Date = new Date(),
  timeZone: string = BUSINESS_TIME_ZONE,
): AutochargeDecision[] {
  return candidates.map((c) => decide(c, now, timeZone));
}
