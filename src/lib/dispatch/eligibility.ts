/**
 * The gate nobody crosses.
 *
 * This mirrors `cleaner_is_eligible()` in migration 0003, which is enforced as
 * a CHECK constraint on the offers table. The database is the authority — this
 * exists so the UI can explain *why* someone is ineligible and so the engine
 * can filter without a round trip, not so it can be bypassed.
 *
 * The 3.9 rating floor is non-negotiable in code (plan section 02). Below the
 * floor a cleaner sees no jobs at all.
 */

import type { Cleaner, DispatchJob } from "./types";

export const MINIMUM_RATING = 3.9;

export type IneligibilityReason =
  | "not_active"
  | "below_rating_floor"
  | "unrated"
  | "background_not_cleared"
  | "insurance_expired"
  | "outside_service_zone"
  | "already_booked"
  | "outside_working_hours";

export interface EligibilityResult {
  eligible: boolean;
  reasons: IneligibilityReason[];
}

export interface EligibilityContext {
  /** Windows this cleaner is already committed to. */
  busyWindows?: readonly { start: Date; end: Date }[];
  /** Duration of the job being offered, for the overlap check. */
  jobDurationMinutes?: number;
  /**
   * The hours this cleaner has said she works, on the day of this job.
   *
   * UNDEFINED MEANS UNKNOWN, NOT "NEVER". Nobody on the roster has declared
   * availability yet, and reading an empty declaration as "works no hours"
   * would make every cleaner ineligible for everything the moment this check
   * shipped. That is the opposite of the `unrated` reading a few lines above,
   * and deliberately so: a missing rating is a data fault on one cleaner and
   * the safe answer is to hold her back, while missing availability is the
   * current state of the entire roster and the safe answer is not to invent a
   * constraint she never stated.
   *
   * An EMPTY ARRAY is different again — it is a declaration that she does not
   * work that day, and it is honoured.
   */
  workingWindows?: readonly { start: Date; end: Date }[];
}

export function checkEligibility(
  cleaner: Cleaner,
  job: DispatchJob,
  context: EligibilityContext = {},
): EligibilityResult {
  const reasons: IneligibilityReason[] = [];

  if (cleaner.status !== "active") reasons.push("not_active");

  // An unrated cleaner is not "above the floor by default". New cleaners are
  // seeded with a provisional rating during onboarding; a null here is a data
  // problem, and the safe reading of a data problem is ineligible.
  if (cleaner.rating === null) {
    reasons.push("unrated");
  } else if (cleaner.rating < MINIMUM_RATING) {
    reasons.push("below_rating_floor");
  }

  if (!cleaner.backgroundCheckCleared) reasons.push("background_not_cleared");

  const jobDate = job.scheduledStart;
  if (cleaner.insuranceExpiresOn && jobDate && cleaner.insuranceExpiresOn <= jobDate) {
    reasons.push("insurance_expired");
  }

  // An empty zone list means "works anywhere", matching the SQL.
  if (cleaner.serviceZips.length > 0 && !cleaner.serviceZips.includes(job.zip)) {
    reasons.push("outside_service_zone");
  }

  const durationMs = (context.jobDurationMinutes ?? job.estimatedCleanMinutes) * 60_000;
  const jobEnd = jobDate ? new Date(jobDate.getTime() + durationMs) : null;

  if (jobDate && jobEnd && context.busyWindows?.length) {
    const overlaps = context.busyWindows.some((w) => w.start < jobEnd && jobDate < w.end);
    if (overlaps) reasons.push("already_booked");
  }

  // The whole job has to fit inside one declared window. A cleaner who works
  // until noon is not available for a two-hour clean starting at 11.
  if (jobDate && jobEnd && context.workingWindows !== undefined) {
    const fits = context.workingWindows.some((w) => w.start <= jobDate && jobEnd <= w.end);
    if (!fits) reasons.push("outside_working_hours");
  }

  return { eligible: reasons.length === 0, reasons };
}

export function eligibleCleaners(
  cleaners: readonly Cleaner[],
  job: DispatchJob,
  contextFor: (cleaner: Cleaner) => EligibilityContext = () => ({}),
): Cleaner[] {
  return cleaners.filter((c) => checkEligibility(c, job, contextFor(c)).eligible);
}

export const REASON_LABELS: Record<IneligibilityReason, string> = {
  not_active: "Not an active cleaner",
  below_rating_floor: `Rating below the ${MINIMUM_RATING} floor`,
  unrated: "No rating on file",
  background_not_cleared: "Background check not cleared",
  insurance_expired: "Insurance lapsed before this job date",
  outside_service_zone: "Outside their service zone",
  already_booked: "Already booked in this window",
  outside_working_hours: "Outside the hours they work",
};
