/**
 * What a clean pays the cleaner.
 *
 * POLICY (Matt, 14 September 2026): the payout is a SHARE OF THE TICKET. Forty
 * percent of whatever the customer pays. A discount to the customer reduces the
 * cleaner's fee proportionally, because the two move together by construction.
 *
 * This replaces a dollars-per-hour ladder, and the reversal is deliberate
 * enough to be worth writing down.
 *
 * WHY PER-HOUR WAS WRONG. The payout was rate × OUR estimate of how long the
 * job takes. That makes the cleaner's fee a function of our guess: estimate a
 * 3bd/3ba at 173 minutes, and if it really takes 240 we have underpaid her by
 * the size of our own error. It is also an employment marker — paying by the
 * hour, even derived, is one of the things that makes someone look like an
 * employee rather than a business we buy a service from, and worker
 * classification is the largest legal exposure in the plan (build plan §09).
 * A published price per clean is how you contract with a business.
 *
 * WHAT IT COSTS, HONESTLY. The build plan moved to per-hour because a flat
 * share pays the worst hourly rate on exactly the jobs that matter most: a
 * weekly 3bd/3ba and a one-time 3bd/3ba are the same house and the same work,
 * but the weekly is discounted, so at the opening share it pays $64.02 against
 * $79.53 — about $22.20/hr against $27.58/hr. On an open board a rational
 * cleaner takes the one-time every time.
 *
 * That objection is weaker than it was, because dispatch no longer works like
 * an open board for established customers: a recurring visit goes to its
 * incumbent exclusively before anyone else sees it, so she is not choosing it
 * against a better-paying stranger's job. The residual risk is ACQUISITION —
 * a NEW recurring customer has no incumbent, gets filled from the board, and
 * is the worst-paying thing on it. `MINIMUM_PAYOUT_CENTS` exists for that and
 * is off by default; if new weeklies are slow to fill, it is the first thing
 * to reach for.
 */

/** The cleaner's share of every ticket. One number, deliberately. */
export const CLEANER_SHARE_OF_TICKET = 0.33;

/**
 * The most a job may escalate to when nobody takes it at the opening share.
 *
 * Aspirational only. The real ceiling is almost always the cheapest W-2
 * marginal cost for that specific job — past it, sending our own employee is
 * cheaper than buying the labour, which is the whole reason the cap is a cost
 * rather than a percentage.
 */
export const MAX_SHARE_OF_TICKET = 0.49;

/**
 * A floor under the payout, in cents, regardless of share. Null = off.
 *
 * The lever for the acquisition problem above: it lifts the discounted jobs
 * without touching the rule everywhere else. Left off because turning it on
 * changes what every recurring clean pays, and that is a decision with a
 * number attached rather than a default.
 */
export const MINIMUM_PAYOUT_CENTS: number | null = null;

export class PayoutError extends Error {}

/**
 * What this clean pays.
 *
 * Rounded to the cent, half away from zero — the payout is what somebody is
 * actually paid, so it cannot carry a fraction of a cent, and rounding down by
 * convention would quietly shave every job in the platform's favour.
 */
export function payoutForTicket(
  priceCents: number,
  share: number = CLEANER_SHARE_OF_TICKET,
  floorCents: number | null = MINIMUM_PAYOUT_CENTS,
): number {
  if (!Number.isFinite(priceCents) || priceCents < 0) {
    throw new PayoutError(`ticket price must be a non-negative number, got ${priceCents}`);
  }
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    throw new PayoutError(`share must be between 0 and 1, got ${share}`);
  }

  const payout = Math.round(priceCents * share);

  // A floor never lifts a payout above the ticket. A clean that pays the
  // cleaner more than the customer paid is not a floor doing its job, it is a
  // misconfiguration, and it should not reach anybody's screen.
  if (floorCents !== null && floorCents > payout) return Math.min(floorCents, priceCents);
  return payout;
}

/** The share a given payout represents. Inverse of the above, for reporting. */
export function shareOfTicket(payoutCents: number, priceCents: number): number {
  if (priceCents <= 0) return 0;
  return payoutCents / priceCents;
}

/**
 * What the cleaner effectively earns per hour on this job.
 *
 * REPORTING ONLY. It is no longer an input to anything — that is the point of
 * the change — but "cleaner earnings per hour" is a metric the business steers
 * by, and a share model makes it vary by job in a way a per-hour model hid. It
 * needs to stay visible precisely because it is no longer controlled.
 */
export function impliedHourlyCents(payoutCents: number, estimatedMinutes: number): number {
  if (estimatedMinutes <= 0) return 0;
  return Math.round((payoutCents * 60) / estimatedMinutes);
}

/**
 * The share at which buying this job costs the same as sending the cheapest
 * available W-2. Past it, the employee is cheaper and the auction should stop.
 */
export function ceilingShareFromW2Cost(w2MarginalCents: number, priceCents: number): number {
  if (priceCents <= 0) return 0;
  return w2MarginalCents / priceCents;
}
