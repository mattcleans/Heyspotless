/**
 * The offer ladder.
 *
 * Offers are denominated in DOLLARS PER HOUR, not a percentage of the ticket.
 * A flat percentage produced a 23% spread in what a cleaner actually earned per
 * hour, and it pointed the wrong way: weekly recurring customers — the most
 * valuable relationships and the ones that must fill every week — paid the
 * worst hourly rate and so were the offers cleaners skipped.
 *
 * Under a per-hour ladder the percentage floats per job (about 29% on a
 * one-time 3bd/2ba, about 36% on a weekly 2bd/2ba) while take-home per hour
 * stays flat, and the offer reads "$57.50 for about 2h20m" — which is what a
 * cleaner actually decides on.
 *
 * The ceiling is not a fixed percentage either. It is the cheapest W-2 marginal
 * cost for this specific job, because past that point sending your own employee
 * is cheaper than buying the labor.
 */

import type { DispatchJob } from "./types";

/** Opening rate. Below this the marketplace does not clear. */
export const OPENING_RATE_CENTS_PER_HOUR = 2500;
/** Aspirational ceiling. The real cap is usually the cheapest W-2 option. */
export const MAX_RATE_CENTS_PER_HOUR = 3200;

export interface LadderConfig {
  openingRateCents: number;
  maxRateCents: number;
  /** Escalation step bounds, randomized within them so the pattern can't be learned. */
  minStepCents: number;
  maxStepCents: number;
  /** Seconds a rung stays open before the next one, also randomized. */
  minDwellSeconds: number;
  maxDwellSeconds: number;
}

export const DEFAULT_LADDER: LadderConfig = {
  openingRateCents: OPENING_RATE_CENTS_PER_HOUR,
  maxRateCents: MAX_RATE_CENTS_PER_HOUR,
  minStepCents: 100,
  maxStepCents: 250,
  minDwellSeconds: 8 * 60,
  maxDwellSeconds: 15 * 60,
};

export interface LadderRung {
  index: number;
  hourlyRateCents: number;
  payoutCents: number;
  /** Share of the ticket. Floats per job — informational, never the input. */
  payoutPct: number;
  /** Seconds after dispatch starts that this rung goes out. */
  offerAtSeconds: number;
  dwellSeconds: number;
}

/** Deterministic when you pass a seeded rng — the tests rely on that. */
export type Rng = () => number;

export function payoutForRate(hourlyRateCents: number, estimatedMinutes: number): number {
  return Math.floor((hourlyRateCents * estimatedMinutes) / 60 + 0.5);
}

/**
 * Convert a W-2 marginal cost into the equivalent hourly rate for this job, so
 * it can cap the ladder.
 */
export function ceilingRateFromW2Cost(w2MarginalCents: number, estimatedMinutes: number): number {
  if (estimatedMinutes <= 0) return 0;
  return Math.floor((w2MarginalCents * 60) / estimatedMinutes);
}

export interface BuildLadderOptions {
  config?: LadderConfig;
  /** The cheapest W-2 option's marginal cost, in cents. Caps the ladder. */
  w2CeilingCents?: number | null;
  rng?: Rng;
}

/**
 * Build the full escalation ladder for a job.
 *
 * The cleaner never sees this. Each rung is presented on its own, as *the*
 * offer, with a countdown and no "this may increase" language — because a
 * visible ascending ladder teaches every rational cleaner to decline the
 * opening rate and wait, which drifts average payout to the ceiling and costs
 * the entire benefit.
 */
export function buildLadder(
  job: DispatchJob,
  options: BuildLadderOptions = {},
): LadderRung[] {
  const config = options.config ?? DEFAULT_LADDER;
  const rng = options.rng ?? Math.random;
  const minutes = job.estimatedCleanMinutes;

  let ceiling = config.maxRateCents;
  if (options.w2CeilingCents != null) {
    ceiling = Math.min(ceiling, ceilingRateFromW2Cost(options.w2CeilingCents, minutes));
  }

  const rungs: LadderRung[] = [];
  let rate = config.openingRateCents;
  let elapsed = 0;
  let index = 0;

  // The opening rung always goes out, even if the ceiling sits below it — the
  // caller decides whether to run an auction at all (see engine.ts).
  while (index === 0 || rate <= ceiling) {
    const dwell = randomInt(rng, config.minDwellSeconds, config.maxDwellSeconds);
    rungs.push({
      index,
      hourlyRateCents: rate,
      payoutCents: payoutForRate(rate, minutes),
      payoutPct: job.priceCents > 0 ? payoutForRate(rate, minutes) / job.priceCents : 0,
      offerAtSeconds: elapsed,
      dwellSeconds: dwell,
    });

    elapsed += dwell;
    index += 1;

    const step = randomInt(rng, config.minStepCents, config.maxStepCents);
    const next = rate + step;
    if (next > ceiling) break;
    rate = next;

    if (index > 64) break; // paranoia; the bounds make this unreachable
  }

  return rungs;
}

/**
 * What the cleaner is actually shown. Deliberately carries no rung index, no
 * ceiling, and no indication that anything might improve.
 */
export interface PresentedOffer {
  jobId: string;
  payoutCents: number;
  estimatedMinutes: number;
  expiresAt: Date;
}

export function presentOffer(job: DispatchJob, rung: LadderRung, dispatchStartedAt: Date): PresentedOffer {
  return {
    jobId: job.id,
    payoutCents: rung.payoutCents,
    estimatedMinutes: job.estimatedCleanMinutes,
    expiresAt: new Date(
      dispatchStartedAt.getTime() + (rung.offerAtSeconds + rung.dwellSeconds) * 1000,
    ),
  };
}

/**
 * Escalation rate — a first-class KPI, instrumented from day one.
 *
 * If too many jobs clear above the opening rate, the base rate is below market
 * and the fix is a higher OPENING rate, not a higher ceiling. The plan's
 * threshold is about 30%.
 */
export const ESCALATION_ALARM_THRESHOLD = 0.3;

export function escalationRate(
  accepted: readonly { hourlyRateCents: number }[],
  openingRateCents: number = OPENING_RATE_CENTS_PER_HOUR,
): number {
  if (accepted.length === 0) return 0;
  const escalated = accepted.filter((o) => o.hourlyRateCents > openingRateCents).length;
  return escalated / accepted.length;
}

/**
 * Tier ranking. Acceptance rate is an input, which is what makes declining
 * cost something: cleaners who take base-rate jobs get first look at more work,
 * and cleaners who hold out for escalation slide down and see less overall.
 */
export interface RankingInputs {
  rating: number;
  acceptanceRate: number;
  driveMinutes: number;
  priorJobsForCustomer: number;
}

export function rankScore(inputs: RankingInputs): number {
  const rating = inputs.rating / 5;
  const acceptance = inputs.acceptanceRate;
  const proximity = 1 / (1 + inputs.driveMinutes / 20);
  const familiarity = Math.min(inputs.priorJobsForCustomer, 5) / 5;
  return 0.35 * rating + 0.3 * acceptance + 0.25 * proximity + 0.1 * familiarity;
}

/** Split ranked candidates into escalation tiers. */
export function assignTiers<T>(ranked: readonly T[], tierSize = 3): T[][] {
  const tiers: T[][] = [];
  for (let i = 0; i < ranked.length; i += tierSize) {
    tiers.push(ranked.slice(i, i + tierSize));
  }
  return tiers;
}

function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
