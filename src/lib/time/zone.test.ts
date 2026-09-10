import { describe, expect, it } from "vitest";
import {
  BUSINESS_TIME_ZONE,
  compareCalendarDates,
  formatCalendarDate,
  formatDateTimeInZone,
  toCalendarDate,
  todayIn,
  toLocalInputValue,
  zonedTimeToUtc,
} from "./zone";

/**
 * Every assertion here is written against an absolute instant, never against
 * "what this machine thinks local time is". That is the point: this file is run
 * twice by `npm run test:zones`, under TZ=UTC and TZ=America/Chicago, and a
 * test that passed by agreeing with the process zone would pass in one run and
 * fail in the other.
 */

function iso(local: string): string {
  const parsed = zonedTimeToUtc(local);
  if (!parsed.ok) throw new Error(`expected ${local} to parse, got ${parsed.reason}`);
  return parsed.date.toISOString();
}

describe("zonedTimeToUtc", () => {
  it("stores a Dallas booking as the instant it names", () => {
    // The acceptance case. 15 September 2026 is central DAYLIGHT time, UTC-5.
    expect(iso("2026-09-15T09:30")).toBe("2026-09-15T14:30:00.000Z");
  });

  it("uses standard time in winter", () => {
    // January is CST, UTC-6 — an hour further from UTC than the September case.
    expect(iso("2026-01-15T09:30")).toBe("2026-01-15T15:30:00.000Z");
  });

  it("keeps the same wall clock across the spring transition", () => {
    // Same 9:30 booking either side of 8 March 2026; the UTC instant differs by
    // an hour precisely because the wall clock did not.
    expect(iso("2026-03-07T09:30")).toBe("2026-03-07T15:30:00.000Z");
    expect(iso("2026-03-09T09:30")).toBe("2026-03-09T14:30:00.000Z");
  });

  it("keeps the same wall clock across the autumn transition", () => {
    expect(iso("2026-10-31T09:30")).toBe("2026-10-31T14:30:00.000Z");
    expect(iso("2026-11-02T09:30")).toBe("2026-11-02T15:30:00.000Z");
  });

  it("accepts seconds and midnight", () => {
    expect(iso("2026-09-15T00:00")).toBe("2026-09-15T05:00:00.000Z");
    expect(iso("2026-09-15T09:30:45")).toBe("2026-09-15T14:30:45.000Z");
  });

  it("refuses the hour the clocks skip", () => {
    // 02:30 on 8 March 2026 does not happen in Chicago. Booking 01:30 or 03:30
    // instead would put a cleaner at a door an hour from when anyone agreed.
    const parsed = zonedTimeToUtc("2026-03-08T02:30");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("nonexistent");
    if (parsed.reason !== "nonexistent") return;
    // The clocks jump at 02:00 CST, which is 08:00 UTC.
    expect(parsed.skippedTo.toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });

  it("resolves the repeated hour to its first occurrence, and says so", () => {
    // 01:30 on 1 November 2026 happens twice. Both are real; one must be picked
    // the same way on every machine.
    const parsed = zonedTimeToUtc("2026-11-01T01:30");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ambiguous).toBe(true);
    expect(parsed.date.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });

  it("does not call an ordinary time ambiguous", () => {
    const parsed = zonedTimeToUtc("2026-11-01T09:30");
    expect(parsed.ok && parsed.ambiguous).toBe(false);
  });

  it("rejects what is not a local date and time", () => {
    for (const raw of ["", "not a date", "2026-09-15", "2026-13-01T09:30", "2026-02-31T09:30",
                       "2026-09-15T25:00", "2026-09-15T09:61"]) {
      expect(zonedTimeToUtc(raw).ok, raw).toBe(false);
    }
  });

  it("round-trips through the value a datetime-local input shows", () => {
    for (const local of ["2026-01-15T09:30", "2026-09-15T09:30", "2026-11-01T01:30"]) {
      const parsed = zonedTimeToUtc(local);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(toLocalInputValue(parsed.date)).toBe(local);
    }
  });

  it("is the same answer in any zone the caller names", () => {
    // Not a business rule — a check that the zone argument is what decides,
    // rather than anything ambient.
    const chicago = zonedTimeToUtc("2026-09-15T09:30", "America/Chicago");
    const utc = zonedTimeToUtc("2026-09-15T09:30", "UTC");
    expect(chicago.ok && chicago.date.toISOString()).toBe("2026-09-15T14:30:00.000Z");
    expect(utc.ok && utc.date.toISOString()).toBe("2026-09-15T09:30:00.000Z");
  });
});

describe("formatDateTimeInZone", () => {
  it("shows business time, whatever the server's zone is", () => {
    const instant = new Date("2026-09-15T14:30:00.000Z");
    expect(formatDateTimeInZone(instant)).toBe("Sep 15, 9:30 AM");
  });

  it("shows an instant late in the UTC day as the Chicago day it belongs to", () => {
    // 01:00 UTC on the 16th is 8pm on the 15th in Dallas. A server formatting
    // in UTC would name the wrong day on every evening appointment.
    expect(formatDateTimeInZone(new Date("2026-09-16T01:00:00.000Z"))).toBe("Sep 15, 8:00 PM");
  });
});

describe("calendar dates", () => {
  it("accepts an ISO day and nothing else", () => {
    expect(toCalendarDate("2026-09-15")).toBe("2026-09-15");
    expect(toCalendarDate("2026-02-29")).toBeNull(); // 2026 is not a leap year
    expect(toCalendarDate("2026-09-15T00:00:00Z")).toBeNull();
    expect(toCalendarDate("2026-9-5")).toBeNull();
    expect(toCalendarDate(null)).toBeNull();
    expect(toCalendarDate(new Date())).toBeNull();
  });

  it("reads today from the business zone, not the process zone", () => {
    // 02:00 UTC on 16 September is still the 15th in Dallas. An invoice due on
    // the 15th must not fall overdue while the office is still open.
    const lateEvening = new Date("2026-09-16T02:00:00.000Z");
    expect(todayIn(BUSINESS_TIME_ZONE, lateEvening)).toBe("2026-09-15");
    expect(todayIn("UTC", lateEvening)).toBe("2026-09-16");
  });

  it("orders lexicographically, which is chronological for ISO days", () => {
    const a = toCalendarDate("2026-09-09")!;
    const b = toCalendarDate("2026-09-10")!;
    expect(compareCalendarDates(a, b)).toBeLessThan(0);
    expect(compareCalendarDates(b, a)).toBeGreaterThan(0);
    expect(compareCalendarDates(a, a)).toBe(0);
  });

  it("formats a day without inventing an instant for it", () => {
    expect(formatCalendarDate(toCalendarDate("2026-09-15")!)).toBe("Sep 15, 2026");
    expect(formatCalendarDate(toCalendarDate("2026-01-01")!)).toBe("Jan 1, 2026");
  });
});
