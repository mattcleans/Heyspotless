/**
 * Turning a cleaner's weekly declaration into windows on an actual day.
 *
 * `cleaner_availability` stores a day of week and two LOCAL times — "Tuesday,
 * 09:00 to 15:00". That is the right way to store it: a cleaner who works nine
 * to three works nine to three in March and in November, and storing it as an
 * instant would move her hours by one twice a year.
 *
 * The cost is that turning it into a real window needs the business calendar,
 * which is why this exists as a pure tested function rather than inline
 * arithmetic at the call site. Everything here is deterministic given a date.
 */

import { utcToZonedParts, zonedTimeToUtc, BUSINESS_TIME_ZONE } from "../time/zone";

/** One declared stretch of a weekday, in local wall clock. `HH:MM` or `HH:MM:SS`. */
export interface DeclaredWindow {
  startsAt: string;
  endsAt: string;
}

export interface Window {
  start: Date;
  end: Date;
}

/** Postgres `time` arrives as `HH:MM:SS`; the parser wants `HH:MM`. */
function hhmm(time: string): string {
  return time.slice(0, 5);
}

/**
 * The concrete windows a cleaner is available on the day `on` falls in.
 *
 * Returns undefined when she has declared nothing at all, which the
 * eligibility gate reads as UNKNOWN rather than as a refusal — see the note on
 * `EligibilityContext.workingWindows`. An empty array is different: it means
 * she has declared hours on other days and none on this one, which is a real
 * answer and is honoured.
 */
export function windowsOn(
  on: Date,
  weekly: ReadonlyMap<number, readonly DeclaredWindow[]> | undefined,
  timeZone: string = BUSINESS_TIME_ZONE,
): Window[] | undefined {
  if (weekly === undefined || weekly.size === 0) return undefined;

  // The day of week where the BUSINESS is, not where the server is. A job at
  // 00:30 UTC on Wednesday is Tuesday evening in Dallas, and reading the
  // server's weekday would look up the wrong day's hours.
  const parts = utcToZonedParts(on, timeZone);
  const localNoon = Date.UTC(parts.year, parts.month - 1, parts.day, 12);
  const dayOfWeek = new Date(localNoon).getUTCDay();

  const declared = weekly.get(dayOfWeek);
  if (!declared || declared.length === 0) return [];

  const datePrefix =
    `${String(parts.year).padStart(4, "0")}-` +
    `${String(parts.month).padStart(2, "0")}-` +
    `${String(parts.day).padStart(2, "0")}`;

  const windows: Window[] = [];
  for (const window of declared) {
    const start = zonedTimeToUtc(`${datePrefix}T${hhmm(window.startsAt)}`, timeZone);
    const end = zonedTimeToUtc(`${datePrefix}T${hhmm(window.endsAt)}`, timeZone);

    // A declared hour that does not exist on this date is the hour the clocks
    // skipped. Dropping the window rather than guessing is the honest answer:
    // the alternative is silently deciding she starts an hour early or late on
    // one Sunday in March, on her behalf.
    if (!start.ok || !end.ok) continue;
    if (end.date <= start.date) continue;

    windows.push({ start: start.date, end: end.date });
  }
  return windows;
}
