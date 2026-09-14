/**
 * The offer ladder.
 *
 * Offers are denominated as a SHARE OF THE TICKET — 40% of whatever the
 * customer pays — and escalate in share, not in dollars per hour. The reasoning
 * for that, and the honest cost of it, is in lib/pricing/payout.ts; this
 * executes it.
 *
 * What the cleaner sees is a price for a clean: "$77.60 for this job". Not a
 * rate, not a percentage, and never a hint that either might move.
 *
 * The ceiling is not a fixed share. It is the cheapest W-2 marginal cost for
 * this specific job, expressed as a share of this job's price, because past
 * that point sending our own employee is cheaper than buying the labour.
 */

import {
  CLEANER_SHARE_OF_TICKET,
  MAX_SHARE_OF_TICKET,
  ceilingShareFromW2Cost,
  impliedHourlyCents,
  payoutForTicket,
} from "../pricing/payout";
import type { DispatchJob } from "./types";

export interface LadderConfig {
  /** Where every job opens. Below this the marketplace does not clear. */
  openingShare: number;
  /** Aspirational ceiling. The real cap is usually the cheapest W-2 option. */
  maxShare: number;
  /**
   * Escalation step bounds in share, randomised within them so the pattern
   * cannot be learned and waited out.
   */
  minStepShare: number;
  maxStepShare: number;
  /** Seconds a rung stays open before the next one, also randomised. */
  minDwellSeconds: number;
  maxDwellSeconds: number;
}

export const DEFAULT_LADDER: LadderConfig = {
  openingShare: CLEANER_SHARE_OF_TICKET,
  maxShare: MAX_SHARE_OF_TICKET,
  minStepShare: 0.015,
  maxStepShare: 0.03,
  minDwellSeconds: 8 * 60,
  maxDwellSeconds: 15 * 60,
};

export interface LadderRung {
  index: number;
  /** The share of the ticket this rung offers. The escalation dimension. */
  share: number;
  payoutCents: number;
  /**
   * What she effectively earns per hour at this rung. REPORTING ONLY — it is
   * an output now, not an input, and it varies per job in a way the old
   * per-hour ladder hid. It stays visible precisely because it is no longer
   * controlled.
   */
  impliedHourlyRateCents: number;
  /** Seconds after dispatch starts that this rung goes out. */
  offerAtSeconds: number;
  dwellSeconds: number;
}

/** Deterministic when you pass a seeded rng — the tests rely on that. */
export type Rng = () => number;

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

  let ceiling = config.maxShare;
  if (options.w2CeilingCents != null) {
    ceiling = Math.min(ceiling, ceilingShareFromW2Cost(options.w2CeilingCents, job.priceCents));
  }

  const rungs: LadderRung[] = [];
  let share = config.openingShare;
  let elapsed = 0;
  let index = 0;

  // The opening rung always goes out, even if the ceiling sits below it — the
  // caller decides whether to run an auction at all (see engine.ts).
  while (index === 0 || share <= ceiling) {
    const dwell = randomInt(rng, config.minDwellSeconds, config.maxDwellSeconds);
    const payoutCents = payoutForTicket(job.priceCents, share);

    rungs.push({
      index,
      share,
      payoutCents,
      impliedHourlyRateCents: impliedHourlyCents(payoutCents, minutes),
      offerAtSeconds: elapsed,
      dwellSeconds: dwell,
    });

    elapsed += dwell;
    index += 1;

    const step = randomShare(rng, config.minStepShare, config.maxStepShare);
    const next = share + step;
    if (next > ceiling) break;
    share = next;

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
  accepted: readonly { share: number }[],
  openingShare: number = CLEANER_SHARE_OF_TICKET,
): number {
  if (accepted.length === 0) return 0;
  const escalated = accepted.filter((o) => o.share > openingShare).length;
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

/**
 * A step in share space. Quantised to hundredths of a percentage point so a
 * rung is a number somebody can read in a report, rather than 0.4150000000001.
 */
function randomShare(rng: Rng, min: number, max: number): number {
  const steps = Math.round((max - min) * 10_000);
  return min + randomInt(rng, 0, steps) / 10_000;
}
