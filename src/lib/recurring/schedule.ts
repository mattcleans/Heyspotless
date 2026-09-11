/**
 * Recurring plans: when the next visits fall.
 *
 * This is the money maker, and it is also the piece where a quiet bug costs
 * the most. A recurring customer is the relationship the whole business is
 * built on; a visit generated twice is a double charge and an embarrassing
 * phone call, and a visit not generated at all is a customer standing in a
 * dirty house wondering where you are. Both are worse than any one-off
 * booking going wrong, because they repeat.
 *
 * So the decision of WHEN is here, pure, with no database and no clock of its
 * own — the same shape as lib/dispatch and lib/billing. Materialising those
 * occurrences into jobs is `generate_recurring_jobs` in 0014, which is
 * idempotent on (plan, occurrence date) so running this twice is a no-op.
 *
 * THE CADENCE is derived from one anchor — the first visit — rather than
 * stored as a pile of rules:
 *
 *   weekly     the anchor's weekday, every 7 calendar days
 *   biweekly   the anchor's weekday, every 14 calendar days
 *   monthly    the anchor's NTH WEEKDAY of the month — "the third Tuesday" —
 *              not its day-of-month. A cleaner's week has a shape; "the 31st"
 *              does not exist in half the year and "the 1st" wanders across
 *              the week. Housekeeping schedules are weekday-shaped, so the
 *              model should be too.
 *
 * Calendar days, never milliseconds. Adding 14 × 86,400,000ms to a timestamp
 * lands an hour out either side of a daylight-saving change; over a year of
 * fortnightly visits that is half of them at the wrong time.
 */

import {
  BUSINESS_TIME_ZONE,
  addCalendarDays,
  addMonths,
  calendarDaysBetween,
  compareCalendarDates,
  dayOfWeek,
  nthWeekdayOfMonth,
  weekdayOrdinalInMonth,
  yearMonthOf,
  zonedTimeToUtc,
  type CalendarDate,
} from "../time/zone";
import type { Frequency } from "../pricing/price-book";

/** How far ahead visits are materialised, in days. */
export const DEFAULT_HORIZON_DAYS = 42;

/**
 * Six weeks ahead is a deliberate compromise. Far enough that dispatch has
 * time to fill a slot through the offer ladder rather than scrambling, and
 * that a customer can see their schedule and move something. Near enough that
 * the board is not clogged with visits nobody has thought about, and that a
 * price change or a cancellation does not have to unpick three months of
 * already-created jobs.
 */

export interface RecurringPlan {
  id: string;
  customerId: string;
  propertyId: string;
  frequency: Frequency;
  /** The first visit. Everything else is derived from it. */
  anchorDate: CalendarDate;
  /** Local wall-clock start, `HH:mm`, in business time. */
  startTime: string;
  /** Inclusive. Null runs until somebody stops it. */
  endsOn: CalendarDate | null;
  /** Visits on or before this are suppressed — a holiday, a long trip. */
  pausedUntil: CalendarDate | null;
  active: boolean;
  /**
   * How far ahead this plan materialises visits. Per-plan so a customer who
   * wants to see further out can, without filling the board for everyone.
   */
  horizonDays: number;
  /** Occurrence dates a person has explicitly called off. */
  skips: readonly CalendarDate[];
}

export interface Occurrence {
  /** The date the plan says this visit belongs to. The idempotency key. */
  date: CalendarDate;
  /** The instant it starts, resolved in business time. */
  startsAt: Date;
  /**
   * True when the local start time did not exist that morning — the hour the
   * clocks skip — and this has been moved to the first real instant after it.
   */
  shiftedForDaylightSaving: boolean;
}

export type SkipReason =
  | "before_anchor"
  | "after_end"
  | "paused"
  | "skipped"
  | "plan_inactive";

/**
 * Every occurrence the plan calls for in `[from, to]`, inclusive.
 *
 * `from` is normally today: visits in the past are not generated, because a
 * plan created on Wednesday should not conjure Monday's clean.
 */
export function occurrencesBetween(
  plan: RecurringPlan,
  from: CalendarDate,
  to: CalendarDate,
  timeZone: string = BUSINESS_TIME_ZONE,
): Occurrence[] {
  if (!plan.active) return [];
  if (compareCalendarDates(from, to) > 0) return [];

  const skips = new Set<string>(plan.skips);
  const out: Occurrence[] = [];

  for (const date of cadence(plan, from, to)) {
    if (compareCalendarDates(date, plan.anchorDate) < 0) continue;
    if (plan.endsOn && compareCalendarDates(date, plan.endsOn) > 0) break;
    if (plan.pausedUntil && compareCalendarDates(date, plan.pausedUntil) <= 0) continue;
    if (skips.has(date)) continue;

    out.push(at(date, plan.startTime, timeZone));
  }

  return out;
}

/**
 * Why a given date is not being generated, or null if it is. The counterpart
 * to `occurrencesBetween`, for explaining a gap on a screen rather than
 * leaving somebody to guess.
 */
export function suppressionReason(plan: RecurringPlan, date: CalendarDate): SkipReason | null {
  if (!plan.active) return "plan_inactive";
  if (compareCalendarDates(date, plan.anchorDate) < 0) return "before_anchor";
  if (plan.endsOn && compareCalendarDates(date, plan.endsOn) > 0) return "after_end";
  if (plan.pausedUntil && compareCalendarDates(date, plan.pausedUntil) <= 0) return "paused";
  if (plan.skips.includes(date)) return "skipped";
  return null;
}

/** The next visit on or after `from`, ignoring nothing. Null if there is none. */
export function nextOccurrence(
  plan: RecurringPlan,
  from: CalendarDate,
  timeZone: string = BUSINESS_TIME_ZONE,
): Occurrence | null {
  // A year is enough to clear any run of skips a person would plausibly
  // enter, and bounded so a fully-skipped plan cannot loop for ever.
  const horizon = addCalendarDays(from, 366);
  return occurrencesBetween(plan, from, horizon, timeZone)[0] ?? null;
}

/**
 * The wall clock of an occurrence, as an instant.
 *
 * The DST gap is handled differently here from the booking form, on purpose.
 * The form REFUSES a nonexistent time, because an operator is standing there
 * and can pick another. Nobody is standing here: refusing would silently drop
 * a visit the customer is expecting, so it moves to the first real instant
 * after the gap and says that it did.
 */
function at(date: CalendarDate, startTime: string, timeZone: string): Occurrence {
  const parsed = zonedTimeToUtc(`${date}T${startTime}`, timeZone);

  if (parsed.ok) {
    return { date, startsAt: parsed.date, shiftedForDaylightSaving: false };
  }
  if (parsed.reason === "nonexistent") {
    return { date, startsAt: parsed.skippedTo, shiftedForDaylightSaving: true };
  }
  // A malformed start time is a broken plan, not a schedule to guess at.
  throw new Error(`recurring plan has an unusable start time: ${startTime}`);
}

/** The raw cadence dates in range, before any suppression is applied. */
function* cadence(plan: RecurringPlan, from: CalendarDate, to: CalendarDate): Generator<CalendarDate> {
  if (plan.frequency === "one_time") {
    // A plan is not the right home for a one-off, but a mis-set row must not
    // produce an infinite series.
    if (compareCalendarDates(plan.anchorDate, from) >= 0 &&
        compareCalendarDates(plan.anchorDate, to) <= 0) {
      yield plan.anchorDate;
    }
    return;
  }

  if (plan.frequency === "weekly" || plan.frequency === "biweekly") {
    const step = plan.frequency === "weekly" ? 7 : 14;

    // Jump straight to the first occurrence at or after `from` rather than
    // walking from the anchor, which may be years back.
    const elapsed = calendarDaysBetween(plan.anchorDate, from);
    const periods = elapsed <= 0 ? 0 : Math.ceil(elapsed / step);
    let date = addCalendarDays(plan.anchorDate, periods * step);

    while (compareCalendarDates(date, to) <= 0) {
      yield date;
      date = addCalendarDays(date, step);
    }
    return;
  }

  // Monthly: the anchor's nth weekday, month by month.
  const weekday = dayOfWeek(plan.anchorDate);
  const ordinal = weekdayOrdinalInMonth(plan.anchorDate);

  let ym = yearMonthOf(compareCalendarDates(from, plan.anchorDate) > 0 ? from : plan.anchorDate);
  const end = yearMonthOf(to);

  while (ym.year * 12 + ym.month <= end.year * 12 + end.month) {
    const date = nthWeekdayOfMonth(ym.year, ym.month, weekday, ordinal);
    if (compareCalendarDates(date, from) >= 0 && compareCalendarDates(date, to) <= 0) {
      yield date;
    }
    ym = addMonths(ym, 1);
  }
}
