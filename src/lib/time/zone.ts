/**
 * Time, in the one zone the business actually operates in.
 *
 * Two different things were being conflated before this file existed, and both
 * were wrong in the same way — they resolved against whatever `TZ` the server
 * process happened to have:
 *
 *   * A SCHEDULED START is an instant. "9:30 on the 15th" means 9:30 as the
 *     customer and the cleaner standing in the driveway experience it, which is
 *     9:30 in America/Chicago, and it is stored as the UTC instant that
 *     corresponds to. `new Date("2026-09-15T09:30")` instead resolves in the
 *     server's zone, so the same booking became a different appointment
 *     depending on where it was deployed.
 *
 *   * A DUE DATE is a calendar day, not an instant. "Due on the 15th" has no
 *     time of day at all, and turning it into midnight-somewhere is what makes
 *     an invoice fall overdue five hours early in a UTC process. Due dates are
 *     therefore carried as `CalendarDate` — the ISO day, as text — and compared
 *     against today-in-Chicago, never against a timestamp.
 *
 * Nothing here takes a dependency on the process time zone, so the results are
 * identical under `TZ=UTC` and `TZ=America/Chicago`. That is asserted by
 * running the whole suite twice; see `npm run test:zones`.
 */

/**
 * Where Hey Spotless works. Every clean, every invoice, one zone.
 *
 * A second market in a different zone would make this a per-property value
 * rather than a constant, and the shape of these functions is what makes that
 * a change of argument rather than a rewrite: they all take the zone.
 */
export const BUSINESS_TIME_ZONE = "America/Chicago";

/** An ISO calendar day, `YYYY-MM-DD`. No time, no zone, no instant. */
export type CalendarDate = string & { readonly __calendarDate: unique symbol };

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** What `<input type="datetime-local">` posts. Seconds are optional. */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

export type ZonedParse =
  | { ok: true; date: Date; ambiguous: boolean }
  /** Not a `YYYY-MM-DDTHH:mm` at all, or the parts are out of range. */
  | { ok: false; reason: "malformed" }
  /** A local time that does not exist: the hour the clocks skipped forward. */
  | { ok: false; reason: "nonexistent"; skippedTo: Date };

/**
 * The offset of `timeZone` at a given instant, in milliseconds.
 *
 * `formatToParts` is the only way to ask the platform what a zone's rules say
 * on a date without shipping a copy of the tz database. Reading the formatted
 * wall-clock back as though it were UTC and subtracting gives the offset that
 * was in effect, which is what both directions of conversion need.
 */
function offsetMsAt(utcMs: number, timeZone: string): number {
  const parts = zoneParts(new Date(utcMs), timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // `formatToParts` has no sub-second field, so the rendered value is truncated
  // to the second. Subtracting the untruncated instant would fold those
  // milliseconds into the "offset" and make two instants inside the same offset
  // compare unequal — which is exactly what the bisection below relies on.
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneParts(date: Date, timeZone: string): ZoneParts {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, formatter);
  }

  const read: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") read[part.type] = Number(part.value);
  }
  return {
    year: read["year"] ?? 0,
    month: read["month"] ?? 1,
    day: read["day"] ?? 1,
    // h23 renders midnight as 00, but a formatter that ever yields 24 would
    // silently shift the day, so it is normalised rather than trusted.
    hour: (read["hour"] ?? 0) % 24,
    minute: read["minute"] ?? 0,
    second: read["second"] ?? 0,
  };
}

/**
 * A wall-clock date and time in `timeZone`, as the instant it names.
 *
 * The two-step is the standard fixed point: guess by pretending the local time
 * is UTC, look up the offset that would actually be in force at that guess,
 * correct, then look up again. For all but two hours a year the second lookup
 * agrees with the first and the answer is exact.
 *
 * The two hours that do not agree are the ones worth being explicit about:
 *
 *   * SPRING FORWARD leaves a gap — 02:30 on 8 March 2026 never happens in
 *     Chicago. Neither candidate instant renders back as the requested time, so
 *     this reports `nonexistent` rather than quietly booking 01:30 or 03:30.
 *     The caller can then say so to whoever typed it.
 *   * FALL BACK repeats an hour — 01:30 on 1 November 2026 happens twice. Both
 *     candidates are real, so the FIRST (still on daylight time) is returned
 *     and `ambiguous` is set. Picking one deterministically matters more than
 *     which one: the alternative is a booking that moves depending on which
 *     server resolved it.
 */
export function zonedTimeToUtc(local: string, timeZone: string = BUSINESS_TIME_ZONE): ZonedParse {
  const match = LOCAL_DATE_TIME.exec(local.trim());
  if (!match) return { ok: false, reason: "malformed" };

  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);

  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, reason: "malformed" };
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: "malformed" };

  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  // A day the calendar does not have — 31 February — overflows into the next
  // month, which is how we catch it without a table of month lengths.
  const rolled = new Date(wall);
  if (rolled.getUTCMonth() !== month - 1 || rolled.getUTCDate() !== day) {
    return { ok: false, reason: "malformed" };
  }

  // Both offsets that could possibly apply: the one in force a day earlier and
  // the one a day later. Every transition is bracketed by that window, and on
  // an ordinary day the two are equal and there is only one candidate.
  //
  // Iterating a single fixed point instead — offset at the guess, correct,
  // repeat — converges on ONE answer and therefore cannot see that a fall-back
  // hour has two. Asking both sides is what makes ambiguity detectable.
  const offsetBefore = offsetMsAt(wall - DAY_MS, timeZone);
  const offsetAfter = offsetMsAt(wall + DAY_MS, timeZone);

  const candidates = offsetBefore === offsetAfter
    ? [wall - offsetBefore]
    : [wall - offsetBefore, wall - offsetAfter];
  const valid = candidates.filter((ms) => rendersAs(ms, wall, timeZone));

  if (valid.length === 0) {
    return {
      ok: false,
      reason: "nonexistent",
      skippedTo: new Date(transitionBetween(wall - DAY_MS, wall + DAY_MS, timeZone)),
    };
  }

  return {
    ok: true,
    date: new Date(Math.min(...valid)),
    ambiguous: valid.length > 1,
  };
}

const DAY_MS = 86_400_000;

/**
 * The exact instant the offset changes between two instants that straddle it.
 *
 * Bisection rather than a table: it is about twenty comparisons to millisecond
 * precision, it needs no tz data of its own, and it is right for whatever rule
 * the platform's zone actually uses — including the ones that are not a whole
 * hour and the ones that moved in a given year.
 */
function transitionBetween(startMs: number, endMs: number, timeZone: string): number {
  const startOffset = offsetMsAt(startMs, timeZone);
  let lo = startMs;
  let hi = endMs;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMsAt(mid, timeZone) === startOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Does this instant render, in `timeZone`, as exactly the requested wall clock? */
function rendersAs(utcMs: number, wallUtcMs: number, timeZone: string): boolean {
  const p = zoneParts(new Date(utcMs), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) === wallUtcMs;
}

/** The instant, as the wall clock reads in `timeZone`. Round-trips `zonedTimeToUtc`. */
export function utcToZonedParts(date: Date, timeZone: string = BUSINESS_TIME_ZONE): ZoneParts {
  return zoneParts(date, timeZone);
}

/**
 * The value to put in a `datetime-local` input so it shows business time.
 *
 * The input has no zone of its own — it renders whatever string it is given —
 * so handing it the browser's rendering of the instant would show a Dallas
 * appointment in the operator's own zone.
 */
export function toLocalInputValue(date: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
  const p = zoneParts(date, timeZone);
  return (
    `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}` +
    `T${pad(p.hour, 2)}:${pad(p.minute, 2)}`
  );
}

// --- calendar dates --------------------------------------------------------

/** `2026-09-15` as a `CalendarDate`, or null if it is not one. */
export function toCalendarDate(raw: unknown): CalendarDate | null {
  if (typeof raw !== "string") return null;
  // Postgres `date` comes back as `YYYY-MM-DD`; a `timestamptz` mistakenly
  // pointed at this would arrive longer, and taking its first ten characters
  // would silently pick a day in the wrong zone. Only an exact day is accepted.
  const match = CALENDAR_DATE.exec(raw.trim());
  if (!match) return null;

  const [, y, mo, d] = match;
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(mo) - 1) return null;
  if (probe.getUTCDate() !== Number(d)) return null;

  return raw.trim() as CalendarDate;
}

/** Today, where the business is. The only correct answer to "is this overdue". */
export function todayIn(timeZone: string = BUSINESS_TIME_ZONE, now: Date = new Date()): CalendarDate {
  const p = zoneParts(now, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}` as CalendarDate;
}

/**
 * Compare two calendar days. Negative when `a` is earlier.
 *
 * Zero-padded ISO days sort lexicographically, which is the whole reason for
 * storing them this way rather than as parsed dates.
 */
export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Calendar arithmetic.
 *
 * Deliberately done on UTC midnights rather than on instants. A recurring
 * clean every 14 days is fourteen CALENDAR days — adding 14 × 86,400,000ms to
 * a timestamp lands an hour out twice a year, which over a year of fortnightly
 * visits is a cleaner turning up at the wrong time for half of them.
 */
function calendarToUtcMs(day: CalendarDate): number {
  const [y, mo, d] = day.split("-").map(Number);
  return Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1);
}

function utcMsToCalendar(ms: number): CalendarDate {
  const d = new Date(ms);
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`
  ) as CalendarDate;
}

/** `n` calendar days later (or earlier, for a negative `n`). */
export function addCalendarDays(day: CalendarDate, n: number): CalendarDate {
  return utcMsToCalendar(calendarToUtcMs(day) + n * DAY_MS);
}

/** Whole calendar days from `a` to `b`. Negative when `b` is earlier. */
export function calendarDaysBetween(a: CalendarDate, b: CalendarDate): number {
  return Math.round((calendarToUtcMs(b) - calendarToUtcMs(a)) / DAY_MS);
}

/** 0 = Sunday, 6 = Saturday — the same numbering as `Date.getUTCDay()`. */
export function dayOfWeek(day: CalendarDate): number {
  return new Date(calendarToUtcMs(day)).getUTCDay();
}

/** Which occurrence of its weekday this is within its month: 1 for the first. */
export function weekdayOrdinalInMonth(day: CalendarDate): number {
  const [, , d] = day.split("-").map(Number);
  return Math.floor(((d ?? 1) - 1) / 7) + 1;
}

/**
 * The `ordinal`-th `weekday` of a month, clamped to the last one present.
 *
 * A plan anchored on the fifth Tuesday cannot be honoured in a month with
 * four, and skipping that month would silently drop a visit somebody is
 * expecting. Clamping to the last Tuesday keeps the cadence.
 */
export function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  ordinal: number,
): CalendarDate {
  const firstOfMonth = Date.UTC(year, month - 1, 1);
  const firstWeekday = new Date(firstOfMonth).getUTCDay();
  const offsetToFirst = (weekday - firstWeekday + 7) % 7;

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const available = Math.floor((daysInMonth - offsetToFirst - 1) / 7) + 1;

  const useOrdinal = Math.min(ordinal, available);
  return utcMsToCalendar(firstOfMonth + (offsetToFirst + (useOrdinal - 1) * 7) * DAY_MS);
}

/** The year and month of a calendar day, as numbers. */
export function yearMonthOf(day: CalendarDate): { year: number; month: number } {
  const [y, mo] = day.split("-").map(Number);
  return { year: y ?? 1970, month: mo ?? 1 };
}

/** `n` months later, as a year/month pair. Handles the December wrap. */
export function addMonths(
  ym: { year: number; month: number },
  n: number,
): { year: number; month: number } {
  const zeroBased = ym.year * 12 + (ym.month - 1) + n;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

/** The instant a calendar day begins, where the business is. For display only. */
export function startOfCalendarDay(
  day: CalendarDate,
  timeZone: string = BUSINESS_TIME_ZONE,
): Date {
  const parsed = zonedTimeToUtc(`${day}T00:00`, timeZone);
  // Midnight is skipped in a handful of zones; Chicago is not one, but falling
  // back to the first real instant is better than throwing on a display path.
  if (parsed.ok) return parsed.date;
  return parsed.reason === "nonexistent" ? parsed.skippedTo : new Date(`${day}T00:00:00Z`);
}

// --- display ---------------------------------------------------------------

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

function displayFormatter(options: Intl.DateTimeFormatOptions, timeZone: string): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let formatter = displayFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
    displayFormatters.set(key, formatter);
  }
  return formatter;
}

/** "Sep 15, 2026" — an instant, shown as the day it falls on in business time. */
export function formatDateInZone(date: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
  return displayFormatter({ month: "short", day: "numeric", year: "numeric" }, timeZone).format(date);
}

/** "Sep 15, 9:30 AM" — the wall clock the cleaner will actually turn up at. */
export function formatDateTimeInZone(date: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
  return displayFormatter(
    { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
    timeZone,
  ).format(date);
}

/** "Sep 15, 2026" for a calendar day, with no instant invented along the way. */
export function formatCalendarDate(day: CalendarDate): string {
  const [y, mo, d] = day.split("-").map(Number);
  return displayFormatter({ month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }, "UTC")
    .format(new Date(Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1)));
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
