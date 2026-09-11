import { describe, expect, it } from "vitest";
import {
  DEFAULT_HORIZON_DAYS,
  nextOccurrence,
  occurrencesBetween,
  suppressionReason,
  type RecurringPlan,
} from "./schedule";
import { toCalendarDate, type CalendarDate } from "../time/zone";

/**
 * Like every other date test in this codebase, nothing here agrees with the
 * process clock. The suite runs under TZ=UTC and TZ=America/Chicago, and a
 * recurring schedule that drifted with the server's zone would be a cleaner
 * arriving an hour early for half the year.
 */
function day(iso: string): CalendarDate {
  const parsed = toCalendarDate(iso);
  if (!parsed) throw new Error(`not a calendar date: ${iso}`);
  return parsed;
}

/** 15 September 2026 is a Tuesday, and the third Tuesday of that month. */
function plan(overrides: Partial<RecurringPlan> = {}): RecurringPlan {
  return {
    id: "plan-1",
    customerId: "cust-1",
    propertyId: "prop-1",
    frequency: "biweekly",
    anchorDate: day("2026-09-15"),
    startTime: "09:30",
    endsOn: null,
    pausedUntil: null,
    active: true,
    horizonDays: 42,
    skips: [],
    ...overrides,
  };
}

const dates = (os: { date: CalendarDate }[]) => os.map((o) => o.date);

describe("cadence", () => {
  it("repeats weekly on the anchor's weekday", () => {
    const os = occurrencesBetween(
      plan({ frequency: "weekly" }),
      day("2026-09-15"),
      day("2026-10-13"),
    );
    expect(dates(os)).toEqual([
      "2026-09-15", "2026-09-22", "2026-09-29", "2026-10-06", "2026-10-13",
    ]);
  });

  it("repeats fortnightly", () => {
    const os = occurrencesBetween(plan(), day("2026-09-15"), day("2026-11-10"));
    expect(dates(os)).toEqual([
      "2026-09-15", "2026-09-29", "2026-10-13", "2026-10-27", "2026-11-10",
    ]);
  });

  it("repeats monthly on the same nth weekday, not the same date", () => {
    // The third Tuesday. A cleaner's week has a shape; "the 15th" wanders
    // across it and lands on a Sunday four times a year.
    const os = occurrencesBetween(
      plan({ frequency: "monthly" }),
      day("2026-09-15"),
      day("2027-01-31"),
    );
    expect(dates(os)).toEqual([
      "2026-09-15", // 3rd Tue Sep
      "2026-10-20", // 3rd Tue Oct
      "2026-11-17", // 3rd Tue Nov
      "2026-12-15", // 3rd Tue Dec
      "2027-01-19", // 3rd Tue Jan
    ]);
  });

  it("clamps a fifth-weekday plan to the last one in a short month", () => {
    // 29 September 2026 is the fifth Tuesday. Most months have four, and
    // skipping those would silently drop a visit somebody is expecting.
    const os = occurrencesBetween(
      plan({ frequency: "monthly", anchorDate: day("2026-09-29") }),
      day("2026-09-29"),
      day("2026-12-31"),
    );
    expect(dates(os)).toEqual([
      "2026-09-29", // 5th Tue
      "2026-10-27", // only four Tuesdays — the last
      "2026-11-24", // only four — the last
      "2026-12-29", // five again
    ]);
  });

  it("starts from the window, not from the anchor, for an old plan", () => {
    // A plan running for two years must not walk 52 fortnights to answer.
    const os = occurrencesBetween(
      plan({ anchorDate: day("2024-09-17") }),
      day("2026-09-15"),
      day("2026-10-14"),
    );
    // 17 Sep 2024 + 14n lands on 15 Sep 2026: exactly 728 days, 52 periods.
    expect(dates(os)).toEqual(["2026-09-15", "2026-09-29", "2026-10-13"]);
  });

  it("never generates before the anchor", () => {
    const os = occurrencesBetween(plan(), day("2026-08-01"), day("2026-09-30"));
    expect(dates(os)).toEqual(["2026-09-15", "2026-09-29"]);
  });

  it("treats a one-off plan as exactly one visit", () => {
    const os = occurrencesBetween(
      plan({ frequency: "one_time" }),
      day("2026-09-01"),
      day("2027-09-01"),
    );
    expect(dates(os)).toEqual(["2026-09-15"]);
  });
});

describe("the wall clock", () => {
  it("starts at the agreed local time, as an instant", () => {
    const [first] = occurrencesBetween(plan(), day("2026-09-15"), day("2026-09-15"));
    // 9:30 in Dallas on 15 September is 14:30 UTC — central daylight time.
    expect(first?.startsAt.toISOString()).toBe("2026-09-15T14:30:00.000Z");
  });

  it("keeps the same wall clock across the autumn change", () => {
    // The whole point of calendar arithmetic. 9:30 stays 9:30 for the
    // customer; the UTC instant is what moves.
    const os = occurrencesBetween(
      plan({ frequency: "weekly", anchorDate: day("2026-10-27") }),
      day("2026-10-27"),
      day("2026-11-10"),
    );
    expect(os.map((o) => o.startsAt.toISOString())).toEqual([
      "2026-10-27T14:30:00.000Z", // CDT, UTC-5
      "2026-11-03T15:30:00.000Z", // CST, UTC-6 — clocks went back on the 1st
      "2026-11-10T15:30:00.000Z",
    ]);
    expect(os.every((o) => !o.shiftedForDaylightSaving)).toBe(true);
  });

  it("keeps the same wall clock across the spring change", () => {
    const os = occurrencesBetween(
      plan({ frequency: "weekly", anchorDate: day("2026-03-03") }),
      day("2026-03-03"),
      day("2026-03-17"),
    );
    expect(os.map((o) => o.startsAt.toISOString())).toEqual([
      "2026-03-03T15:30:00.000Z", // CST
      "2026-03-10T14:30:00.000Z", // CDT — clocks went forward on the 8th
      "2026-03-17T14:30:00.000Z",
    ]);
  });

  it("moves a visit out of the hour that does not exist, rather than dropping it", () => {
    // Nobody books a 2:30am clean, but a plan must not silently lose a visit
    // if one exists. The booking FORM refuses this time because an operator
    // is there to pick another; here there is nobody, so it shifts and says so.
    const os = occurrencesBetween(
      plan({ frequency: "weekly", startTime: "02:30", anchorDate: day("2026-03-08") }),
      day("2026-03-08"),
      day("2026-03-08"),
    );
    expect(os).toHaveLength(1);
    expect(os[0]?.shiftedForDaylightSaving).toBe(true);
    // 02:00 CST is 08:00 UTC — the first real instant of the new offset.
    expect(os[0]?.startsAt.toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });

  it("refuses a plan whose start time is not a time", () => {
    expect(() =>
      occurrencesBetween(plan({ startTime: "half nine" }), day("2026-09-15"), day("2026-09-15")),
    ).toThrow(/unusable start time/);
  });
});

describe("skips, pauses and endings", () => {
  it("leaves out a visit somebody called off, and keeps the cadence", () => {
    // A skip is a hole, not a shift. The visit after a skipped one stays
    // where it always was — otherwise calling off one clean quietly moves
    // every clean after it.
    const os = occurrencesBetween(
      plan({ skips: [day("2026-09-29")] }),
      day("2026-09-15"),
      day("2026-10-27"),
    );
    expect(dates(os)).toEqual(["2026-09-15", "2026-10-13", "2026-10-27"]);
  });

  it("suppresses everything up to and including the pause date", () => {
    const os = occurrencesBetween(
      plan({ pausedUntil: day("2026-10-13") }),
      day("2026-09-15"),
      day("2026-11-10"),
    );
    expect(dates(os)).toEqual(["2026-10-27", "2026-11-10"]);
  });

  it("stops at the end date, inclusive", () => {
    const os = occurrencesBetween(
      plan({ endsOn: day("2026-10-13") }),
      day("2026-09-15"),
      day("2026-12-31"),
    );
    expect(dates(os)).toEqual(["2026-09-15", "2026-09-29", "2026-10-13"]);
  });

  it("generates nothing for an inactive plan", () => {
    expect(
      occurrencesBetween(plan({ active: false }), day("2026-09-15"), day("2026-12-31")),
    ).toEqual([]);
  });

  it("generates nothing when the window is backwards", () => {
    expect(occurrencesBetween(plan(), day("2026-10-01"), day("2026-09-01"))).toEqual([]);
  });
});

describe("suppressionReason", () => {
  it("explains a gap rather than leaving somebody to guess", () => {
    expect(suppressionReason(plan({ skips: [day("2026-09-29")] }), day("2026-09-29")))
      .toBe("skipped");
    expect(suppressionReason(plan({ pausedUntil: day("2026-10-13") }), day("2026-09-29")))
      .toBe("paused");
    expect(suppressionReason(plan({ endsOn: day("2026-09-20") }), day("2026-09-29")))
      .toBe("after_end");
    expect(suppressionReason(plan(), day("2026-09-01"))).toBe("before_anchor");
    expect(suppressionReason(plan({ active: false }), day("2026-09-29"))).toBe("plan_inactive");
  });

  it("says nothing is wrong with a visit that will happen", () => {
    expect(suppressionReason(plan(), day("2026-09-29"))).toBeNull();
  });
});

describe("nextOccurrence", () => {
  it("finds the next visit from a date mid-cycle", () => {
    expect(nextOccurrence(plan(), day("2026-09-20"))?.date).toBe("2026-09-29");
  });

  it("looks past a run of skips", () => {
    const skipped = plan({ skips: [day("2026-09-15"), day("2026-09-29"), day("2026-10-13")] });
    expect(nextOccurrence(skipped, day("2026-09-15"))?.date).toBe("2026-10-27");
  });

  it("returns null for a plan that has ended", () => {
    expect(nextOccurrence(plan({ endsOn: day("2026-09-20") }), day("2026-10-01"))).toBeNull();
  });

  it("terminates on a plan skipped into oblivion rather than looping", () => {
    const everySkipped = plan({
      skips: Array.from({ length: 40 }, (_, i) =>
        day(new Date(Date.UTC(2026, 8, 15) + i * 14 * 86_400_000).toISOString().slice(0, 10)),
      ),
    });
    expect(nextOccurrence(everySkipped, day("2026-09-15"))).toBeNull();
  });
});

describe("the generation horizon", () => {
  it("is six weeks", () => {
    expect(DEFAULT_HORIZON_DAYS).toBe(42);
  });

  it("yields three fortnightly visits, which is what the board should hold", () => {
    const os = occurrencesBetween(plan(), day("2026-09-15"), day("2026-10-27"));
    expect(os).toHaveLength(4);
  });
});
