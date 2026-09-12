/**
 * Continuity — the incumbent's first refusal.
 *
 * The marketplace promise is not "somebody will clean your house". It is "your
 * cleaner will clean your house, and if she cannot, we still will". The second
 * half is what dispatch already does well. This file is the first half.
 *
 * Without it every recurring visit is re-auctioned from scratch, and the
 * cleaner a customer has built four months of trust with competes for that
 * customer's own house against strangers on drive time and acceptance rate.
 * That is not a marketplace failure mode to fix later — it is the product
 * working backwards.
 *
 * So the incumbent gets the job offered to her ALONE for a bounded window
 * before anyone else sees it. Bounded matters in both directions: too short
 * and the hold is theatre, because a cleaner mid-clean cannot answer within
 * ten minutes; too long and a Tuesday visit is still unfilled on Monday night.
 * The window therefore scales with how much lead time there is to spend.
 *
 * Everything here is pure. No database, no clock, no randomness — the same
 * posture as marginal-cost.ts and ladder.ts, because this decides who gets
 * work and that has to be assertable without standing up infrastructure.
 */

import { checkEligibility, type EligibilityContext } from "./eligibility";
import type { Cleaner, DispatchJob } from "./types";

/**
 * What the platform knows about this home's relationships.
 *
 * Two separate signals, deliberately not collapsed into one:
 *
 *   `preferredCleanerId`  — what the customer (or the office) SAID. It lives
 *                           on the recurring plan and is an explicit choice.
 *   `incumbentCleanerId`  — what actually HAPPENED. Whoever cleaned this home
 *                           last, whether anyone ever wrote it down.
 *
 * A stated preference outranks a revealed one, because a customer who asked
 * for Sarah has told us something the history cannot: that the last visit
 * being somebody else was a substitution, not a change of heart.
 */
export interface ContinuityContext {
  preferredCleanerId: string | null;
  incumbentCleanerId: string | null;
  /** Completed visits by the incumbent at this property. */
  priorVisits: number;
  /**
   * The cleaner hourly rate agreed when this relationship formed, in cents.
   *
   * The mirror of `recurring_plans.agreed_price_cents`. Together they fix the
   * SPREAD for the life of the plan, which matters precisely because a pairing
   * that works lasts years: the margin agreed at formation is the margin for
   * years. Locking only the customer half — which is what shipped before 0017
   * — meant a change to the global opening rate silently moved the margin on
   * every existing relationship, with no record of what was ever agreed.
   *
   * Null means unlocked, not free: the current opening rate applies, which is
   * the honest reading for a pairing that predates the column.
   */
  agreedPayoutRateCents?: number | null;
}

export type ContinuityBasis = "preferred" | "incumbent";

/**
 * One visit is a coincidence. An incumbency the customer never asked for has
 * to be earned by repetition before it starts blocking the open board.
 *
 * A STATED preference is exempt — it needs no history, because the customer
 * already told us. That is the whole difference between the two signals.
 */
export const MIN_VISITS_FOR_INCUMBENCY = 2;

/**
 * Below this much lead time, continuity loses to speed.
 *
 * A clean three hours away is a backfill, and a backfill that waits politely
 * for one person to answer is a customer with a dirty house. The relationship
 * is better served by someone turning up.
 */
export const MIN_LEAD_HOURS_FOR_HOLD = 4;

/**
 * The most a hold may ever consume of the remaining lead time.
 *
 * The caps below are absolute; this is the proportional guard that stops a
 * job three days out from spending a full day of its runway waiting on one
 * answer. Whichever is smaller wins.
 */
export const MAX_HOLD_FRACTION_OF_LEAD = 0.25;

/** Absolute ceilings by urgency band, in seconds. */
export const HOLD_CAPS = {
  /** Three days or more out — she has a day to look at it. */
  relaxed: 24 * 3600,
  /** Inside three days. Long enough to span a working day and a night. */
  soon: 4 * 3600,
  /** Inside a day. Long enough to finish the clean she is standing in. */
  urgent: 45 * 60,
} as const;

/** Hours out at which each band starts. Mirrors URGENT_THRESHOLD_HOURS. */
export const RELAXED_BAND_HOURS = 72;
export const SOON_BAND_HOURS = 24;

/**
 * How long the incumbent gets the job to herself.
 *
 * Returns 0 when there is no room for a hold at all, which the caller reads as
 * "run the ordinary ladder now".
 */
export function holdWindowSeconds(hoursUntilJob: number): number {
  if (hoursUntilJob < MIN_LEAD_HOURS_FOR_HOLD) return 0;

  const cap =
    hoursUntilJob >= RELAXED_BAND_HOURS
      ? HOLD_CAPS.relaxed
      : hoursUntilJob >= SOON_BAND_HOURS
        ? HOLD_CAPS.soon
        : HOLD_CAPS.urgent;

  // An unscheduled job has infinite lead; the cap is the answer.
  if (!Number.isFinite(hoursUntilJob)) return cap;

  const proportional = Math.floor(hoursUntilJob * 3600 * MAX_HOLD_FRACTION_OF_LEAD);
  return Math.min(cap, proportional);
}

export interface ContinuityHold {
  held: true;
  cleaner: Cleaner;
  basis: ContinuityBasis;
  holdSeconds: number;
  /** They have it alone until this moment. */
  expiresAt: Date;
}

/**
 * Why no one holds this job.
 *
 * Reported rather than collapsed to null because these are four different
 * facts about the business and only one of them is benign. "No relationship"
 * is a new customer. "Incumbent ineligible" is a cleaner who has lapsed a
 * requirement and whose customers are about to be reassigned — which somebody
 * should know about before the customer finds out.
 */
export type ContinuityMissReason =
  | "no_relationship"
  | "too_few_visits"
  | "incumbent_ineligible"
  | "incumbent_passed"
  | "no_lead_time";

export interface ContinuityMiss {
  held: false;
  reason: ContinuityMissReason;
}

export type ContinuityResolution = ContinuityHold | ContinuityMiss;

export interface ResolveContinuityOptions {
  now: Date;
  hoursUntilJob: number;
  eligibilityFor?: (cleaner: Cleaner, job: DispatchJob) => EligibilityContext;
  /**
   * The rate the hold would be offered at. A cleaner who has already refused
   * this job at this rate is not held for again — otherwise the sweep asks her
   * the same question every hour until the visit happens.
   */
  offerRateCents?: number;
}

/**
 * Who, if anyone, holds this job.
 *
 * Eligibility is checked here and not merely assumed from the caller's roster,
 * because the gate is absolute (plan section 02) and a preferred cleaner whose
 * background check lapsed is not a preferred cleaner. A named cleaner who
 * cannot take the job is the same as no named cleaner at all — the job falls
 * through to the ordinary path rather than waiting on someone who may not have
 * it.
 */
export function resolveContinuity(
  job: DispatchJob,
  cleaners: readonly Cleaner[],
  options: ResolveContinuityOptions,
): ContinuityResolution {
  const continuity = job.continuity;
  if (!continuity) return { held: false, reason: "no_relationship" };
  if (continuity.preferredCleanerId === null && continuity.incumbentCleanerId === null) {
    return { held: false, reason: "no_relationship" };
  }

  const holdSeconds = holdWindowSeconds(options.hoursUntilJob);
  if (holdSeconds <= 0) return { held: false, reason: "no_lead_time" };

  const eligibilityFor = options.eligibilityFor ?? (() => ({}));
  const eligible = (cleaner: Cleaner | undefined): cleaner is Cleaner =>
    cleaner !== undefined && checkEligibility(cleaner, job, eligibilityFor(cleaner, job)).eligible;

  const byId = (id: string | null) =>
    id === null ? undefined : cleaners.find((c) => c.id === id);

  const passed = (cleaner: Cleaner) =>
    hasPassedAtOrAbove(job, cleaner.id, options.offerRateCents ?? 0);

  const hold = (cleaner: Cleaner, basis: ContinuityBasis): ContinuityHold => ({
    held: true,
    cleaner,
    basis,
    holdSeconds,
    expiresAt: new Date(options.now.getTime() + holdSeconds * 1000),
  });

  // Stated preference first, and with no visit threshold — the customer asked.
  const preferred = byId(continuity.preferredCleanerId);
  if (preferred && passed(preferred)) {
    // She has already been asked at this rate and did not take it. Holding
    // the job for her again asks the same question every hour, and keeps the
    // visit off the open board while it goes unanswered.
    return { held: false, reason: "incumbent_passed" };
  }
  if (eligible(preferred)) return hold(preferred, "preferred");

  // A named preference that cannot take the job is worth saying out loud: it
  // is the signal that this customer is about to be substituted, and it is
  // the same signal whether the cleaner is paused, out of zone, or simply
  // already booked that morning.
  if (continuity.preferredCleanerId !== null) {
    return { held: false, reason: "incumbent_ineligible" };
  }

  // Then revealed preference, once it has happened often enough to mean
  // something.
  if (continuity.priorVisits < MIN_VISITS_FOR_INCUMBENCY) {
    return { held: false, reason: "too_few_visits" };
  }

  const incumbent = byId(continuity.incumbentCleanerId);
  if (incumbent && passed(incumbent)) {
    return { held: false, reason: "incumbent_passed" };
  }
  if (eligible(incumbent)) return hold(incumbent, "incumbent");

  return { held: false, reason: "incumbent_ineligible" };
}

/**
 * What the hold costs, in cents, against the cheapest thing we would otherwise
 * have done.
 *
 * Continuity is worth paying for; it is not worth paying for BLINDLY. Every
 * hold records this so the business can answer "what does the same-cleaner
 * promise cost us per clean" with a number instead of a conviction, and so a
 * pathological case — an incumbent who is always the most expensive option in
 * the market — shows up in reporting rather than in the margin.
 *
 * Negative means continuity is free or better: the incumbent WAS the cheapest
 * option, which is the ordinary case for a W-2 cleaner on a settled route.
 */
/**
 * Has this cleaner already been asked about this job at this rate or better,
 * and not taken it?
 *
 * "Or better" rather than "exactly", because passing on $30/h obviously
 * settles the question at $25/h too, and re-asking downward is the fastest way
 * to teach a cleaner that answering means nothing.
 */
export function hasPassedAtOrAbove(
  job: DispatchJob,
  cleanerId: string,
  hourlyRateCents: number,
): boolean {
  return (job.passedOver ?? []).some(
    (p) => p.cleanerId === cleanerId && p.hourlyRateCents >= hourlyRateCents,
  );
}

export function holdCostCents(
  incumbentCents: number,
  cheapestAlternativeCents: number | null,
): number | null {
  if (cheapestAlternativeCents === null) return null;
  return incumbentCents - cheapestAlternativeCents;
}

/**
 * A cost ceiling on continuity — OFF by default, and deliberately so.
 *
 * 0015 shipped this at 15% of the ticket and applied it to any incumbency the
 * customer had not explicitly asked for. In practice it fired constantly: the
 * comparison that matters is almost always against an idle W-2 inside
 * guaranteed hours, which costs nothing, so the premium was a contractor's
 * whole payout — 33-36% of the ticket at every job size on the current
 * pricelist. The effective rule was "a customer loses their cleaner whenever
 * Shonda has a spare hour", which is the opposite of the product.
 *
 * The policy (Matt, 12 September 2026) is that a relationship ends for a
 * REASON — the customer asks for somebody else, the customer complains, the
 * cleaner cannot take it, or she turns it down — and never because payroll had
 * a gap that week. So nothing is waived on cost unless somebody switches this
 * on, and `null` is the default.
 *
 * The premium is still computed and recorded on every decision. That is not
 * vestigial: the spread agreed when a pairing forms is the spread for as long
 * as it lasts, so what continuity costs is exactly the number the business
 * needs in front of it — it just is not a number that quietly reassigns
 * anybody.
 */
export const MAX_CONTINUITY_PREMIUM_FRACTION: number | null = null;

/** Null means no ceiling: continuity is not given up on price. */
export function continuityPremiumCapCents(priceCents: number): number | null {
  if (MAX_CONTINUITY_PREMIUM_FRACTION === null) return null;
  return Math.floor(priceCents * MAX_CONTINUITY_PREMIUM_FRACTION);
}

/**
 * What actually happened to the continuity promise on this job, recorded on
 * every decision the engine makes.
 *
 * This is the §13 instrumentation: "percentage completed by the preferred or
 * incumbent cleaner" and "substitution rate" are both derivable from this
 * field alone, and neither can be reconstructed afterwards from a job row
 * that only says who ended up doing the work.
 */
export type ContinuityOutcome =
  | {
      status: "held";
      cleanerId: string;
      basis: ContinuityBasis;
      expiresAt: Date;
      premiumCents: number | null;
    }
  | {
      status: "assigned";
      cleanerId: string;
      basis: ContinuityBasis;
      premiumCents: number | null;
    }
  | {
      status: "waived_too_costly";
      cleanerId: string;
      basis: ContinuityBasis;
      premiumCents: number;
      capCents: number;
    }
  | { status: "none"; reason: ContinuityMissReason };
