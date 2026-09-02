/**
 * The true marginal cost of a W-2 cleaner for one specific job.
 *
 * This replaces the flat payout ceiling the plan originally proposed, which did
 * not survive contact with real drive times: at a 30-minute drive Shonda's
 * overtime hour costs 53.3% of a $170 ticket and loses to a 50% marketplace
 * job, while at a 15-minute drive it costs 48.8% and wins. A fixed percentage
 * gets that backwards half the time.
 *
 * The model, verified against both tables in section 04 of the build plan:
 *
 *     wage     = billable hours x applicable rate x (1 + employer burden)
 *     mileage  = reimbursed miles x the IRS rate in effect on the job date
 *     marginal = wage + mileage, with hours inside a guarantee costing nothing
 *
 * Hours are split across three bands: hours already covered by a weekly
 * guarantee are sunk and cost zero at the margin; hours between the guarantee
 * and the overtime threshold bill at the base rate; hours beyond it bill at the
 * overtime multiplier.
 */

import type { Cleaner, DriveLeg, W2Terms } from "./types";

/**
 * Wage arithmetic is done in exact integers and rounded once, half up.
 *
 * This is not fussiness. A 2.3-hour job plus a 40-minute drive at $21/hr with a
 * 15% burden costs exactly 7164.5 cents — a real half cent — and three of the
 * eight rows in the build plan's comparison table land on that boundary. The
 * plan rounds them inconsistently (7164.5 up, 6359.5 and 8452.5 down), which is
 * the signature of float error in whatever produced it. Accumulating
 * `hours * rate * 1.15` in floating point reproduces that error; scaling to
 * integers first does not. The tests allow one cent against the published
 * figures for exactly this reason.
 */
const SCALE = 10_000;

function scaled(x: number): number {
  return Math.round(x * SCALE);
}

function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.floor(Math.abs(x) + 0.5);
}

/**
 * Wage cost in cents for a split of regular and overtime minutes.
 * Exact: numerator and denominator are integers well inside Number.MAX_SAFE_INTEGER
 * for any realistic week.
 */
export function wageCents(
  regularMinutes: number,
  overtimeMinutes: number,
  baseRateCents: number,
  overtimeMultiplier: number,
  employerBurdenRate: number,
): number {
  const otScale = scaled(overtimeMultiplier);
  const burdenScale = SCALE + scaled(employerBurdenRate);
  const numerator =
    (regularMinutes * baseRateCents * SCALE + overtimeMinutes * baseRateCents * otScale) *
    burdenScale;
  const denominator = 60 * SCALE * SCALE;
  return roundHalfUp(numerator / denominator);
}

/**
 * IRS business standard mileage rate, in cents per mile, by effective date.
 * The IRS raised it midyear in 2026 — the first such change since 2022 — so a
 * hardcoded constant would silently misreimburse. Mirrors the `mileage_rates`
 * table in migration 0002.
 */
export const IRS_MILEAGE_RATES: readonly { from: Date; centsPerMile: number }[] = [
  { from: new Date("2026-01-01T00:00:00Z"), centsPerMile: 72.5 },
  { from: new Date("2026-07-01T00:00:00Z"), centsPerMile: 76 },
];

export function mileageRateCentsPerMile(on: Date): number {
  let rate = IRS_MILEAGE_RATES[0]?.centsPerMile ?? 0;
  for (const row of IRS_MILEAGE_RATES) {
    if (on >= row.from) rate = row.centsPerMile;
  }
  return rate;
}

export interface CostBreakdown {
  /** Hours inside a weekly guarantee — already paid for, zero at the margin. */
  sunkHours: number;
  regularHours: number;
  overtimeHours: number;
  /** Wage cost of the non-sunk hours, employer burden included. */
  wageCents: number;
  /** Mileage reimbursement. Not wages, so not burdened. */
  mileageCents: number;
  /** What this job actually adds to payroll. The number dispatch compares. */
  marginalCents: number;
  /**
   * Wage cost of all hours including the sunk ones. Useful for reporting true
   * job cost, but never for deciding who to send.
   */
  fullyBurdenedCents: number;
}

export interface CostInputs {
  cleanMinutes: number;
  drive: DriveLeg;
  /** Defaults to now; determines which IRS mileage rate applies. */
  jobDate?: Date;
}

/**
 * Split billable minutes into sunk / regular / overtime bands given how much of
 * the week the cleaner has already worked. Works in whole minutes so the wage
 * arithmetic downstream stays exact.
 */
function splitMinutes(
  minutes: number,
  minutesAlreadyWorked: number,
  terms: W2Terms,
): { sunk: number; regular: number; overtime: number } {
  const guaranteed = Math.round((terms.guaranteedHoursPerWeek ?? 0) * 60);
  const otThreshold = Math.round(terms.overtimeThresholdHours * 60);

  let remaining = minutes;
  let cursor = minutesAlreadyWorked;

  const take = (limit: number): number => {
    if (remaining <= 0) return 0;
    const available = Math.max(0, limit - cursor);
    const used = Math.min(remaining, available);
    remaining -= used;
    cursor += used;
    return used;
  };

  const sunk = take(guaranteed);
  const regular = take(Math.max(guaranteed, otThreshold));
  const overtime = remaining;

  return { sunk, regular, overtime };
}

/**
 * Marginal cost of assigning this job to this W-2 cleaner right now.
 *
 * Returns null for a cleaner with no W-2 terms — a 1099 contractor has no
 * marginal cost in this sense; their cost is whatever the auction clears at.
 */
export function w2MarginalCost(cleaner: Cleaner, inputs: CostInputs): CostBreakdown | null {
  const terms = cleaner.terms;
  if (!terms) return null;

  const cleanMinutes = Math.round(inputs.cleanMinutes);
  const driveMinutes = terms.driveTimePaid ? Math.round(inputs.drive.minutes) : 0;
  const billableMinutes = cleanMinutes + driveMinutes;

  const { sunk, regular, overtime } = splitMinutes(
    billableMinutes,
    Math.round(cleaner.hoursScheduledThisWeek * 60),
    terms,
  );

  const wage = wageCents(
    regular,
    overtime,
    terms.hourlyRateCents,
    terms.overtimeMultiplier,
    terms.employerBurdenRate,
  );
  const fullyBurdenedWage = wageCents(
    sunk + regular,
    overtime,
    terms.hourlyRateCents,
    terms.overtimeMultiplier,
    terms.employerBurdenRate,
  );

  const mileage = terms.usesCompanyVehicle
    ? 0
    : roundHalfUp(inputs.drive.miles * mileageRateCentsPerMile(inputs.jobDate ?? new Date()));

  return {
    sunkHours: sunk / 60,
    regularHours: regular / 60,
    overtimeHours: overtime / 60,
    wageCents: wage,
    mileageCents: mileage,
    marginalCents: wage + mileage,
    fullyBurdenedCents: fullyBurdenedWage + mileage,
  };
}

export interface W2Option {
  cleaner: Cleaner;
  cost: CostBreakdown;
}

/**
 * The cheapest W-2 option for this job. This is the auction ceiling: the
 * waterfall escalates only until the market price crosses it, because past that
 * point sending your own employee is cheaper.
 *
 * Note the ordering this produces is not fixed. At a short drive Iggy at $21
 * beats Shonda's $26.25 overtime hour; past roughly a 40-minute drive her
 * mileage reimbursement overtakes it and the order flips. That is exactly why
 * this is recomputed per job rather than held as a ranking.
 */
export function cheapestW2Option(
  candidates: readonly Cleaner[],
  inputsFor: (cleaner: Cleaner) => CostInputs,
): W2Option | null {
  let best: W2Option | null = null;

  for (const cleaner of candidates) {
    const cost = w2MarginalCost(cleaner, inputsFor(cleaner));
    if (!cost) continue;
    if (!best || cost.marginalCents < best.cost.marginalCents) {
      best = { cleaner, cost };
    }
  }

  return best;
}

/** Does this job fit entirely inside the cleaner's unspent guaranteed hours? */
export function fitsInGuaranteedHours(cleaner: Cleaner, inputs: CostInputs): boolean {
  const cost = w2MarginalCost(cleaner, inputs);
  return cost !== null && cost.regularHours === 0 && cost.overtimeHours === 0;
}

/** Guaranteed hours bought but not yet scheduled — the idle-hours dashboard tile. */
export function unspentGuaranteedHours(cleaner: Cleaner): number {
  const guaranteed = cleaner.terms?.guaranteedHoursPerWeek ?? 0;
  return Math.max(0, guaranteed - cleaner.hoursScheduledThisWeek);
}

export function unspentGuaranteedCents(cleaner: Cleaner): number {
  const terms = cleaner.terms;
  if (!terms) return 0;
  const minutes = Math.round(unspentGuaranteedHours(cleaner) * 60);
  return wageCents(minutes, 0, terms.hourlyRateCents, terms.overtimeMultiplier, terms.employerBurdenRate);
}
