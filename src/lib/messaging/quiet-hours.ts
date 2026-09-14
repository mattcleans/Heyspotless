/**
 * When the platform may text a cleaner.
 *
 * An offer nobody is told about is not an offer, and the countdowns dispatch
 * runs on are short — a waterfall rung lives 8 to 15 minutes. So the decision
 * "may we send this now" is really the decision "is this offer real", and it
 * belongs next to dispatch rather than buried in a send function.
 *
 * Pure and business-time aware, like everything else that depends on the
 * calendar: quiet hours are 8pm to 8am WHERE THE BUSINESS IS, and that must not
 * drift by an hour twice a year or depend on the server's zone.
 */

import { utcToZonedParts, BUSINESS_TIME_ZONE } from "../time/zone";

/**
 * The window during which the platform will text a cleaner unprompted, in
 * business-local hours. 08:00 up to but not including 20:00.
 *
 * A stated default, and a policy number rather than a technical one — if it
 * should be 07:00 for a roster that starts early, this is the line to change.
 */
export const QUIET_HOURS_START = 20;
export const QUIET_HOURS_END = 8;

/**
 * How close a job has to be before quiet hours stop applying.
 *
 * The exception exists because the alternative is worse. A customer with a
 * clean booked for 9am and no cleaner at 6am is a failure that a 6am text
 * prevents; deferring that offer to 08:00 leaves one hour to fill it. Outside
 * this window there is no such urgency and a night text is just rudeness with a
 * business justification attached.
 */
export const URGENT_OVERRIDE_HOURS = 12;

export type SendWindow =
  | { send: true; reason: "in_hours" | "urgent_override" }
  | { send: false; reason: "quiet_hours"; nextOpening: Date };

export function isQuietHour(at: Date, timeZone: string = BUSINESS_TIME_ZONE): boolean {
  const { hour } = utcToZonedParts(at, timeZone);
  // The window wraps midnight, so this is an OR rather than a range check.
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

/**
 * The next instant at which sending is allowed, given it is not allowed now.
 *
 * Computed by walking forward an hour at a time rather than by arithmetic on
 * the wall clock, because the business calendar has two days a year where
 * adding an hour to 01:30 does not produce 02:30. Cheap — at most sixteen
 * iterations, and only on the path that is already deferring.
 */
export function nextSendWindow(at: Date, timeZone: string = BUSINESS_TIME_ZONE): Date {
  let cursor = at;
  for (let i = 0; i < 24; i++) {
    if (!isQuietHour(cursor, timeZone)) return cursor;
    cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
  }
  return cursor;
}

export interface SendWindowOptions {
  /** Hours until the job starts. Infinity for an unscheduled job. */
  hoursUntilJob: number;
  timeZone?: string;
}

/**
 * May we tell a cleaner about this offer right now?
 *
 * The caller's job is to believe the answer. A `false` here means the OFFER
 * should not be written either — writing one nobody can be told about starts a
 * countdown against a cleaner who has no way to answer it, and it expires
 * having taught the system she passed on work she was never shown.
 */
export function sendWindowFor(now: Date, options: SendWindowOptions): SendWindow {
  const timeZone = options.timeZone ?? BUSINESS_TIME_ZONE;

  if (!isQuietHour(now, timeZone)) return { send: true, reason: "in_hours" };
  if (options.hoursUntilJob < URGENT_OVERRIDE_HOURS) {
    return { send: true, reason: "urgent_override" };
  }
  return { send: false, reason: "quiet_hours", nextOpening: nextSendWindow(now, timeZone) };
}
