/**
 * The dispatch engine.
 *
 * Every job runs this path:
 *
 *   Step 0  Does this home already have a cleaner? If so she gets it, or gets
 *           first refusal on it, before anyone else sees it. Continuity is the
 *           product; the cost optimisation below exists to fill the gaps in it,
 *           not to compete with it. Bounded, priced, and recorded — see
 *           continuity.ts.
 *   Step 1  Is a W-2 cleaner still inside guaranteed hours? Assign — the
 *           marginal cost is zero, because that block is already bought.
 *   Step 2  The eligibility gate. Rating below 3.9, background not cleared,
 *           insurance lapsed, out of zone, or already booked, and the cleaner
 *           never sees the job at all.
 *   Step 3  How urgent? Scheduled work sits on an open board at the opening
 *           rate. Urgent work — same-day, cancellation backfills — goes out as
 *           a timed waterfall whose payout climbs only until it crosses the
 *           cheapest W-2 option for this specific job.
 *
 * The objective is not "pay as little as possible". It is: maximize utilization
 * of labor already paid for, then buy the remainder as cheaply as possible
 * without dropping below the quality bar.
 */

import { cheapestW2Option, unspentGuaranteedHours, w2MarginalCost } from "./marginal-cost";
import { checkEligibility, type EligibilityContext } from "./eligibility";
import {
  continuityPremiumCapCents,
  holdCostCents,
  resolveContinuity,
  type ContinuityBasis,
  type ContinuityOutcome,
} from "./continuity";
import {
  DEFAULT_LADDER,
  type LadderConfig,
  type LadderRung,
  type Rng,
  assignTiers,
  buildLadder,
  payoutForRate,
  rankScore,
} from "./ladder";
import type { Cleaner, DispatchJob, DriveLeg } from "./types";

/** Jobs closer than this go out as a waterfall rather than sitting on a board. */
export const URGENT_THRESHOLD_HOURS = 72;

export interface DispatchContext {
  now: Date;
  cleaners: readonly Cleaner[];
  /** Drive from wherever this cleaner's previous stop is to this job. */
  driveFor: (cleaner: Cleaner, job: DispatchJob) => DriveLeg;
  eligibilityFor?: (cleaner: Cleaner, job: DispatchJob) => EligibilityContext;
  priorJobsFor?: (cleaner: Cleaner, job: DispatchJob) => number;
  /**
   * Override the continuity premium cap for this job. Defaults to a share of
   * the ticket — see MAX_CONTINUITY_PREMIUM_FRACTION.
   */
  continuityPremiumCapCents?: number;
  ladderConfig?: LadderConfig;
  rng?: Rng;
}

/**
 * Every decision carries what happened to the continuity promise, including
 * the decisions where nothing did. A board posting that says "this customer
 * has no incumbent" and one that says "her cleaner was 40% more expensive than
 * the alternative so we let it go to market" look identical in a job row and
 * are completely different facts about the business.
 */
export type DispatchDecision =
  | {
      kind: "assign_guaranteed";
      cleaner: Cleaner;
      /** Always 0 — that is the point. */
      marginalCents: number;
      unspentHoursBefore: number;
      continuity: ContinuityOutcome;
      rationale: string;
    }
  | {
      kind: "assign_w2";
      cleaner: Cleaner;
      marginalCents: number;
      continuity: ContinuityOutcome;
      rationale: string;
    }
  | {
      /**
       * The incumbent has it to herself. Nothing is offered to anyone else,
       * and no ladder is built, until `exclusiveUntil` passes or she answers.
       *
       * She is OFFERED it rather than assigned it because she is an
       * independent contractor: a platform that schedules a contractor without
       * asking is exercising the kind of control that makes her an employee,
       * and the relationship is not worth buying at that price. A W-2 cleaner
       * in the same position is assigned, above, which is what employment is.
       */
      kind: "hold_for_incumbent";
      cleaner: Cleaner;
      basis: ContinuityBasis;
      payoutCents: number;
      hourlyRateCents: number;
      exclusiveUntil: Date;
      /** What runs if she declines or the hold lapses unanswered. */
      fallback: "open_board" | "waterfall";
      continuity: ContinuityOutcome;
      rationale: string;
    }
  | {
      kind: "open_board";
      payoutCents: number;
      hourlyRateCents: number;
      promoteToWaterfallAt: Date;
      eligible: Cleaner[];
      continuity: ContinuityOutcome;
      rationale: string;
    }
  | {
      kind: "waterfall";
      ladder: LadderRung[];
      tiers: Cleaner[][];
      w2CeilingCents: number | null;
      w2Fallback: Cleaner | null;
      continuity: ContinuityOutcome;
      rationale: string;
    }
  | {
      kind: "no_eligible_cleaner";
      continuity: ContinuityOutcome;
      rationale: string;
    };

export function hoursUntil(job: DispatchJob, now: Date): number {
  if (!job.scheduledStart) return Number.POSITIVE_INFINITY;
  return (job.scheduledStart.getTime() - now.getTime()) / 3_600_000;
}

export function isUrgent(job: DispatchJob, now: Date): boolean {
  return hoursUntil(job, now) < URGENT_THRESHOLD_HOURS;
}

export function dispatch(job: DispatchJob, context: DispatchContext): DispatchDecision {
  const { now, cleaners, driveFor } = context;
  const eligibilityFor = context.eligibilityFor ?? (() => ({}));

  const inputsFor = (cleaner: Cleaner) => ({
    cleanMinutes: job.estimatedCleanMinutes,
    drive: driveFor(cleaner, job),
    jobDate: job.scheduledStart ?? now,
  });

  // --- Step 2 first as a filter: an ineligible cleaner is not a candidate for
  // any step, including the guaranteed-hours assignment. The gate is absolute.
  const eligible = cleaners.filter(
    (c) => checkEligibility(c, job, eligibilityFor(c, job)).eligible,
  );

  if (eligible.length === 0) {
    return {
      kind: "no_eligible_cleaner",
      continuity: { status: "none", reason: "incumbent_ineligible" },
      rationale: "No cleaner cleared the eligibility gate for this job.",
    };
  }

  // --- Step 0: continuity. The incumbent gets it, or gets first refusal on
  // it, before anything below runs.
  const resolution = resolveContinuity(job, eligible, {
    now,
    hoursUntilJob: hoursUntil(job, now),
    eligibilityFor,
  });

  // Priced against what we would otherwise have done. `null` means there was
  // no alternative to compare with, in which case the premium question does
  // not arise — the incumbent is not more expensive than nothing.
  const premiumFor = (incumbent: Cleaner, incumbentCents: number): number | null => {
    const others = eligible.filter((c) => c.id !== incumbent.id);
    const alternative = cheapestAlternativeCents(others, job, inputsFor, context);
    return holdCostCents(incumbentCents, alternative);
  };

  // Assigned on every path below: a resolution that did not hold reports why,
  // and one that did either returns a decision or falls through as a waiver.
  let continuity: ContinuityOutcome;

  if (!resolution.held) {
    continuity = { status: "none", reason: resolution.reason };
  } else {
    const { cleaner, basis } = resolution;
    const config0 = context.ladderConfig ?? DEFAULT_LADDER;

    // What honouring this costs us for this specific job. A W-2 incumbent is
    // priced at her marginal cost; a contractor at what we would have to offer
    // her, which is the opening rate — the ladder is for finding the clearing
    // price of an UNKNOWN job, and this one is not unknown to her.
    const w2Cost = w2MarginalCost(cleaner, inputsFor(cleaner));
    const incumbentCents =
      w2Cost?.marginalCents ??
      payoutForRate(config0.openingRateCents, job.estimatedCleanMinutes);

    const premium = premiumFor(cleaner, incumbentCents);
    const cap = context.continuityPremiumCapCents ?? continuityPremiumCapCents(job.priceCents);

    /**
     * A STATED preference is a commitment and is not priced.
     *
     * This is the one place the cost engine does not get a vote, and the line
     * is drawn between the two continuity signals rather than at a number.
     * The customer ASKED for this cleaner. Quietly sending someone else
     * because an idle guaranteed hour made it cheaper is not an optimisation,
     * it is breaking the promise the customer is paying for — and it is
     * precisely the experience that makes a customer take their cleaner's
     * phone number and stop paying us at all.
     *
     * If honouring a stated preference is genuinely untenable, that is a
     * conversation with the customer or a change to their plan. It is an
     * exception for a person, not an override for a sweep.
     *
     * A REVEALED incumbency is different: nobody promised anything, and
     * continuity is being chosen because it is usually better. Usually better
     * can lose to a big enough number, so the cap applies there.
     */
    const pricedAgainstCap = basis === "incumbent";

    if (pricedAgainstCap && premium !== null && premium > cap) {
      // Continuity has a price and this is over it. The job goes to market —
      // and the fact that it did is recorded against the cleaner and the
      // amount, so "we keep substituting Mrs Smith" is answerable.
      continuity = {
        status: "waived_too_costly",
        cleanerId: cleaner.id,
        basis,
        premiumCents: premium,
        capCents: cap,
      };
    } else if (cleaner.type === "w2_core" && w2Cost !== null) {
      const unspent = unspentGuaranteedHours(cleaner);
      const free = w2Cost.marginalCents === 0 && unspent > 0;
      continuity = { status: "assigned", cleanerId: cleaner.id, basis, premiumCents: premium };

      return free
        ? {
            kind: "assign_guaranteed",
            cleaner,
            marginalCents: 0,
            unspentHoursBefore: unspent,
            continuity,
            rationale:
              `${cleaner.name} already cleans this home and is inside guaranteed hours — ` +
              `continuity and cost agree, so it is hers at no marginal payroll.`,
          }
        : {
            kind: "assign_w2",
            cleaner,
            marginalCents: w2Cost.marginalCents,
            continuity,
            rationale:
              `${cleaner.name} already cleans this home. Kept with the customer at ` +
              `$${(w2Cost.marginalCents / 100).toFixed(2)} for this job` +
              (premium !== null && premium > 0
                ? `, $${(premium / 100).toFixed(2)} above the cheapest alternative.`
                : `, which is also the cheapest option available.`),
          };
    } else {
      // A contractor. Offered, not assigned — and to her alone until the hold
      // lapses.
      const payoutCents = payoutForRate(config0.openingRateCents, job.estimatedCleanMinutes);
      continuity = {
        status: "held",
        cleanerId: cleaner.id,
        basis,
        expiresAt: resolution.expiresAt,
        premiumCents: premium,
      };

      return {
        kind: "hold_for_incumbent",
        cleaner,
        basis,
        payoutCents,
        hourlyRateCents: config0.openingRateCents,
        exclusiveUntil: resolution.expiresAt,
        fallback: isUrgent(job, now) ? "waterfall" : "open_board",
        continuity,
        rationale:
          (basis === "preferred"
            ? `${cleaner.name} is this customer's requested cleaner. `
            : `${cleaner.name} has cleaned this home ${job.continuity?.priorVisits ?? 0} times. `) +
          `She has it to herself for ${formatHold(resolution.holdSeconds)}; if she declines or ` +
          `does not answer it goes to the ${isUrgent(job, now) ? "waterfall" : "open board"}.`,
      };
    }
  }

  // --- Step 1: spend guaranteed hours before a dollar reaches the market.
  const guaranteed = eligible
    .filter((c) => {
      const cost = w2MarginalCost(c, inputsFor(c));
      return cost !== null && cost.marginalCents === 0 && unspentGuaranteedHours(c) > 0;
    })
    // Prefer the shortest drive: route density is worth about $5,887 a year.
    .sort((a, b) => driveFor(a, job).minutes - driveFor(b, job).minutes);

  const first = guaranteed[0];
  if (first) {
    return {
      kind: "assign_guaranteed",
      cleaner: first,
      marginalCents: 0,
      unspentHoursBefore: unspentGuaranteedHours(first),
      continuity,
      rationale:
        `${first.name} is inside guaranteed hours, so this job adds nothing to payroll. ` +
        `${unspentGuaranteedHours(first).toFixed(1)}h of the guarantee remain unspent.`,
    };
  }

  // --- The auction ceiling: the cheapest W-2 option for THIS job.
  const w2Candidates = eligible.filter((c) => c.terms);
  const cheapest = cheapestW2Option(w2Candidates, inputsFor);
  const w2CeilingCents = cheapest?.cost.marginalCents ?? null;

  const marketplace = eligible.filter((c) => c.type === "contractor_1099");

  // If nobody is in the marketplace, the W-2 option is the only option.
  if (marketplace.length === 0) {
    if (!cheapest) {
      return {
        kind: "no_eligible_cleaner",
        continuity,
        rationale: "No marketplace cleaner and no W-2 cleaner available for this job.",
      };
    }
    return {
      kind: "assign_w2",
      cleaner: cheapest.cleaner,
      marginalCents: cheapest.cost.marginalCents,
      continuity,
      rationale:
        `No marketplace supply. ${cheapest.cleaner.name} is the cheapest available ` +
        `option at $${(cheapest.cost.marginalCents / 100).toFixed(2)} for this job.`,
    };
  }

  const ranked = [...marketplace].sort(
    (a, b) =>
      rankScore({
        rating: b.rating ?? 0,
        acceptanceRate: b.acceptanceRate ?? 0,
        driveMinutes: driveFor(b, job).minutes,
        priorJobsForCustomer: context.priorJobsFor?.(b, job) ?? 0,
      }) -
      rankScore({
        rating: a.rating ?? 0,
        acceptanceRate: a.acceptanceRate ?? 0,
        driveMinutes: driveFor(a, job).minutes,
        priorJobsForCustomer: context.priorJobsFor?.(a, job) ?? 0,
      }),
  );

  const config = context.ladderConfig ?? DEFAULT_LADDER;

  // --- Step 3: urgency decides board versus waterfall.
  if (!isUrgent(job, now)) {
    const promoteAt = job.scheduledStart
      ? new Date(job.scheduledStart.getTime() - URGENT_THRESHOLD_HOURS * 3_600_000)
      : new Date(now.getTime() + 24 * 3_600_000);

    return {
      kind: "open_board",
      hourlyRateCents: config.openingRateCents,
      payoutCents: payoutForRate(config.openingRateCents, job.estimatedCleanMinutes),
      promoteToWaterfallAt: promoteAt,
      eligible: ranked,
      continuity,
      rationale:
        `Scheduled more than ${URGENT_THRESHOLD_HOURS}h out — posted to the open board ` +
        `at the base rate. Promotes to the waterfall if unclaimed.`,
    };
  }

  const ladder = buildLadder(job, {
    config,
    w2CeilingCents,
    rng: context.rng,
  });

  return {
    kind: "waterfall",
    ladder,
    tiers: assignTiers(ranked),
    w2CeilingCents,
    w2Fallback: cheapest?.cleaner ?? null,
    continuity,
    rationale:
      `Under ${URGENT_THRESHOLD_HOURS}h out. Escalating by tier` +
      (cheapest
        ? ` up to $${(cheapest.cost.marginalCents / 100).toFixed(2)}, ` +
          `where ${cheapest.cleaner.name} becomes cheaper and takes it instead.`
        : " to the ceiling."),
  };
}

// ---------------------------------------------------------------------------
// Planning a whole board
// ---------------------------------------------------------------------------

export interface BoardEntry<J extends DispatchJob = DispatchJob> {
  job: J;
  decision: DispatchDecision;
}

/**
 * Dispatch a set of jobs as a batch.
 *
 * Deciding each job independently is wrong in a way that is easy to miss: every
 * job would be told the same guaranteed hours are free, and a board of six jobs
 * would each claim the same 8.5 unspent hours. Capacity has to be consumed as
 * it is allocated.
 *
 * Jobs are planned soonest-first, so the most urgent work has first claim on
 * the cheap hours; unscheduled jobs are planned last.
 */
export function dispatchBoard<J extends DispatchJob>(
  jobs: readonly J[],
  context: DispatchContext,
): BoardEntry<J>[] {
  const load = new Map<string, number>(
    context.cleaners.map((c) => [c.id, c.hoursScheduledThisWeek]),
  );

  const order = [...jobs].sort((a, b) => {
    const at = a.scheduledStart?.getTime() ?? Number.POSITIVE_INFINITY;
    const bt = b.scheduledStart?.getTime() ?? Number.POSITIVE_INFINITY;
    return at - bt;
  });

  const entries: BoardEntry<J>[] = [];

  for (const job of order) {
    const roster = context.cleaners.map((c) => ({
      ...c,
      hoursScheduledThisWeek: load.get(c.id) ?? c.hoursScheduledThisWeek,
    }));

    const decision = dispatch(job, { ...context, cleaners: roster });
    entries.push({ job, decision });

    // Consume capacity so the next job sees a truthful roster.
    //
    // A HOLD counts, even though nobody has agreed to anything yet. Planning
    // the rest of the board as though the incumbent will decline is the wrong
    // assumption in the ordinary case — she usually accepts, and a board that
    // assumed otherwise would hold the same cleaner for two Tuesday mornings.
    // If she declines, the job re-enters dispatch and the capacity comes back
    // with it.
    if (
      decision.kind === "assign_guaranteed" ||
      decision.kind === "assign_w2" ||
      decision.kind === "hold_for_incumbent"
    ) {
      const id = decision.cleaner.id;
      const drive = context.driveFor(decision.cleaner, job).minutes;
      const hours = (job.estimatedCleanMinutes + drive) / 60;
      load.set(id, (load.get(id) ?? 0) + hours);
    }
  }

  return entries;
}

/** Remaining unspent guaranteed hours per cleaner after planning a board. */
export function residualGuaranteedHours(
  entries: readonly BoardEntry[],
  context: DispatchContext,
): Map<string, number> {
  const load = new Map<string, number>(
    context.cleaners.map((c) => [c.id, c.hoursScheduledThisWeek]),
  );

  for (const { job, decision } of entries) {
    if (decision.kind === "assign_guaranteed" || decision.kind === "assign_w2") {
      const drive = context.driveFor(decision.cleaner, job).minutes;
      load.set(
        decision.cleaner.id,
        (load.get(decision.cleaner.id) ?? 0) + (job.estimatedCleanMinutes + drive) / 60,
      );
    }
  }

  const residual = new Map<string, number>();
  for (const c of context.cleaners) {
    const guaranteed = c.terms?.guaranteedHoursPerWeek ?? 0;
    residual.set(c.id, Math.max(0, guaranteed - (load.get(c.id) ?? 0)));
  }
  return residual;
}

/**
 * The cheapest way to get this job done WITHOUT a particular cleaner — the
 * counterfactual a continuity premium is measured against.
 *
 * W-2 candidates are priced at their true marginal cost for this job.
 * Contractors are priced at the opening rate, which is a floor rather than a
 * forecast: what they would actually clear at is the thing the ladder exists
 * to discover, and pretending to know it here would make the premium look
 * smaller than it is. Pricing the alternative low is the conservative
 * direction — it makes continuity look MORE expensive, not less, so the cap
 * never waves through a premium on the strength of an optimistic guess.
 *
 * Null when there is no alternative at all, which is not a cost of zero: it
 * means the incumbent is the only way this house gets cleaned.
 */
function cheapestAlternativeCents(
  others: readonly Cleaner[],
  job: DispatchJob,
  inputsFor: (cleaner: Cleaner) => { cleanMinutes: number; drive: DriveLeg; jobDate: Date },
  context: DispatchContext,
): number | null {
  if (others.length === 0) return null;

  const config = context.ladderConfig ?? DEFAULT_LADDER;
  const openingPayout = payoutForRate(config.openingRateCents, job.estimatedCleanMinutes);

  let best: number | null = null;
  for (const cleaner of others) {
    const cost =
      cleaner.type === "w2_core"
        ? (w2MarginalCost(cleaner, inputsFor(cleaner))?.marginalCents ?? null)
        : openingPayout;
    if (cost === null) continue;
    if (best === null || cost < best) best = cost;
  }
  return best;
}

/** "24h", "4h", "45m" — for the rationale a human reads on the board. */
function formatHold(seconds: number): string {
  if (seconds >= 3600) {
    const hours = seconds / 3600;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  return `${Math.round(seconds / 60)}m`;
}
