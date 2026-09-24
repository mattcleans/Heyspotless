/**
 * Manual assignment: who a manager can put on a job, and who the picker
 * suggests first.
 *
 * The default follows the owner's rule, in order:
 *
 *   1. Shonda, if she is available and the job keeps her at or under 40 hours
 *      for that week.
 *   2. Otherwise Ignis, on the same test.
 *   3. Otherwise nobody — the job is left for the contractor pool, which the
 *      dispatch sweep offers it to.
 *
 * Shonda and Ignis are not matched by name. They are the W-2 cleaners, and
 * Shonda comes first because she is the one with guaranteed hours: those are
 * paid whether or not they are worked, so filling them first is also the
 * cheapest choice. Ordering by terms rather than names keeps the rule working
 * through a rename or a new hire.
 *
 * Picking a W-2 cleaner assigns her. Picking a contractor only OFFERS her the
 * job — exclusively, on the terms below — and she is on it once she accepts.
 *
 * Pure, like the rest of lib/dispatch.
 */

import { checkEligibility, type EligibilityContext, type IneligibilityReason } from "./eligibility";
import { holdWindowSeconds } from "./continuity";
import { hoursUntil } from "./engine";
import { DEFAULT_LADDER } from "./ladder";
import type { Cleaner, DispatchJob } from "./types";
import { payoutForTicket } from "../pricing/payout";
import { addCalendarDays, dayOfWeek, startOfCalendarDay, todayIn } from "../time/zone";

/** The weekly ceiling for the default pick. Past it is overtime. */
export const DEFAULT_ASSIGNEE_WEEKLY_HOURS = 40;

export interface Week {
  start: Date;
  end: Date;
}

/** Monday 00:00 to the next Monday 00:00, in business time, around `at`. */
export function businessWeekOf(at: Date): Week {
  const day = todayIn(undefined, at);
  const monday = addCalendarDays(day, -((dayOfWeek(day) + 6) % 7));
  return {
    start: startOfCalendarDay(monday),
    end: startOfCalendarDay(addCalendarDays(monday, 7)),
  };
}

/** A job a cleaner is already on, as far as her weekly hours are concerned. */
export interface ScheduledWork {
  cleanerId: string;
  start: Date;
  /** The scheduled end, or start + the estimate when there is none. */
  end: Date;
  minutes: number;
  status: string;
}

/** Hours this cleaner already has in the given week. */
export function hoursInWeek(work: readonly ScheduledWork[], cleanerId: string, week: Week): number {
  let minutes = 0;
  for (const w of work) {
    if (w.cleanerId === cleanerId && w.start >= week.start && w.start < week.end) {
      minutes += w.minutes;
    }
  }
  return minutes / 60;
}

export interface AssigneeOption {
  cleaner: Cleaner;
  eligible: boolean;
  reasons: IneligibilityReason[];
  /** Hours already booked in the week of this job, before it. */
  weekHours: number;
}

export interface ManualAssignmentPlan {
  /** Everyone active, default candidates first. */
  options: AssigneeOption[];
  /** Null means the contractor pool. */
  defaultCleanerId: string | null;
}

export interface ManualAssignmentInputs {
  eligibilityFor?: (cleaner: Cleaner) => EligibilityContext;
  weekHoursFor: (cleaner: Cleaner) => number;
  weeklyHoursCap?: number;
}

/** W-2 first, the one with the biggest guarantee first among them, then by name. */
function priority(a: Cleaner, b: Cleaner): number {
  const w2 = (c: Cleaner) => (c.type === "w2_core" ? 0 : 1);
  if (w2(a) !== w2(b)) return w2(a) - w2(b);
  const guarantee = (c: Cleaner) => c.terms?.guaranteedHoursPerWeek ?? 0;
  if (guarantee(a) !== guarantee(b)) return guarantee(b) - guarantee(a);
  return a.name.localeCompare(b.name);
}

export function planManualAssignment(
  job: DispatchJob,
  cleaners: readonly Cleaner[],
  inputs: ManualAssignmentInputs,
): ManualAssignmentPlan {
  const cap = inputs.weeklyHoursCap ?? DEFAULT_ASSIGNEE_WEEKLY_HOURS;
  const jobHours = job.estimatedCleanMinutes / 60;

  const options = cleaners
    .filter((c) => c.status === "active")
    .sort(priority)
    .map((cleaner): AssigneeOption => {
      const { eligible, reasons } = checkEligibility(
        cleaner,
        job,
        inputs.eligibilityFor?.(cleaner) ?? {},
      );
      return { cleaner, eligible, reasons, weekHours: inputs.weekHoursFor(cleaner) };
    });

  const pick = options.find(
    (o) => o.cleaner.type === "w2_core" && o.eligible && o.weekHours + jobHours <= cap,
  );

  return { options, defaultCleanerId: pick?.cleaner.id ?? null };
}

/** However close the job, a contractor gets at least this long to answer. */
export const MIN_MANUAL_OFFER_SECONDS = 30 * 60;

export interface ManualOfferTerms {
  share: number;
  payoutCents: number;
  expiresAt: Date;
}

/**
 * What a contractor is offered when a manager picks her.
 *
 * The same terms the engine would give her: a relationship's agreed share if
 * the job has one, otherwise the opening share or wherever the ladder has
 * already carried this job, never lower. The countdown is the incumbent-hold
 * window for this much lead time, with a floor so a same-day pick is still
 * answerable, and never past the start of the job.
 */
export function manualOfferTerms(job: DispatchJob, now: Date): ManualOfferTerms {
  const share =
    job.continuity?.agreedPayoutShare ??
    Math.max(DEFAULT_LADDER.openingShare, job.offeredUpToShare ?? 0);

  const seconds = Math.max(holdWindowSeconds(hoursUntil(job, now)), MIN_MANUAL_OFFER_SECONDS);
  let expiresAt = new Date(now.getTime() + seconds * 1000);
  if (job.scheduledStart && job.scheduledStart > now && job.scheduledStart < expiresAt) {
    expiresAt = job.scheduledStart;
  }

  return { share, payoutCents: payoutForTicket(job.priceCents, share), expiresAt };
}
