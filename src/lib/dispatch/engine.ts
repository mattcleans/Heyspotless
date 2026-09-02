/**
 * The dispatch engine.
 *
 * Every job runs this path:
 *
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
  ladderConfig?: LadderConfig;
  rng?: Rng;
}

export type DispatchDecision =
  | {
      kind: "assign_guaranteed";
      cleaner: Cleaner;
      /** Always 0 — that is the point. */
      marginalCents: number;
      unspentHoursBefore: number;
      rationale: string;
    }
  | {
      kind: "assign_w2";
      cleaner: Cleaner;
      marginalCents: number;
      rationale: string;
    }
  | {
      kind: "open_board";
      payoutCents: number;
      hourlyRateCents: number;
      promoteToWaterfallAt: Date;
      eligible: Cleaner[];
      rationale: string;
    }
  | {
      kind: "waterfall";
      ladder: LadderRung[];
      tiers: Cleaner[][];
      w2CeilingCents: number | null;
      w2Fallback: Cleaner | null;
      rationale: string;
    }
  | {
      kind: "no_eligible_cleaner";
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
      rationale: "No cleaner cleared the eligibility gate for this job.",
    };
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
        rationale: "No marketplace cleaner and no W-2 cleaner available for this job.",
      };
    }
    return {
      kind: "assign_w2",
      cleaner: cheapest.cleaner,
      marginalCents: cheapest.cost.marginalCents,
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
    if (decision.kind === "assign_guaranteed" || decision.kind === "assign_w2") {
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
