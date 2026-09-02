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
  | "already_booked";

export interface EligibilityResult {
  eligible: boolean;
  reasons: IneligibilityReason[];
}

export interface EligibilityContext {
  /** Windows this cleaner is already committed to. */
  busyWindows?: readonly { start: Date; end: Date }[];
  /** Duration of the job being offered, for the overlap check. */
  jobDurationMinutes?: number;
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

  if (jobDate && context.busyWindows?.length) {
    const durationMs = (context.jobDurationMinutes ?? job.estimatedCleanMinutes) * 60_000;
    const jobEnd = new Date(jobDate.getTime() + durationMs);
    const overlaps = context.busyWindows.some((w) => w.start < jobEnd && jobDate < w.end);
    if (overlaps) reasons.push("already_booked");
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
};
