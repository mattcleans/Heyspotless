import { describe, expect, it } from "vitest";
import { businessWeekOf, hoursInWeek, planManualAssignment } from "./manual";
import { contractor, iggy, shonda } from "./fixtures";
import type { Cleaner, DispatchJob } from "./types";

function job(overrides: Partial<DispatchJob> = {}): DispatchJob {
  return {
    id: "job-1",
    priceCents: 21900,
    estimatedCleanMinutes: 180, // 3 hours
    zip: "75024",
    scheduledStart: new Date("2026-09-10T15:00:00Z"),
    ...overrides,
  };
}

function plan(cleaners: Cleaner[], hours: Record<string, number>, j = job()) {
  return planManualAssignment(j, cleaners, { weekHoursFor: (c) => hours[c.id] ?? 0 });
}

describe("the default assignee", () => {
  it("is Shonda when she is free and under 40 hours", () => {
    const result = plan([contractor(), iggy(), shonda()], { shonda: 20, iggy: 5 });
    expect(result.defaultCleanerId).toBe("shonda");
  });

  it("moves to Ignis when the job would take Shonda past 40 hours", () => {
    const result = plan([shonda(), iggy(), contractor()], { shonda: 38, iggy: 10 });
    expect(result.defaultCleanerId).toBe("iggy");
  });

  it("allows a job that lands Shonda on exactly 40 hours", () => {
    expect(plan([shonda(), iggy()], { shonda: 37 }).defaultCleanerId).toBe("shonda");
  });

  it("moves to Ignis when Shonda is not available", () => {
    const busy = {
      eligibilityFor: (c: Cleaner) =>
        c.id === "shonda"
          ? {
              busyWindows: [
                {
                  start: new Date("2026-09-10T14:00:00Z"),
                  end: new Date("2026-09-10T17:00:00Z"),
                },
              ],
            }
          : {},
      weekHoursFor: () => 0,
    };
    const result = planManualAssignment(job(), [shonda(), iggy()], busy);
    expect(result.defaultCleanerId).toBe("iggy");
    const shondaOption = result.options.find((o) => o.cleaner.id === "shonda");
    expect(shondaOption?.reasons).toContain("already_booked");
  });

  it("leaves the job for the contractor pool when both are full", () => {
    const result = plan([shonda(), iggy(), contractor()], { shonda: 40, iggy: 39 });
    expect(result.defaultCleanerId).toBeNull();
  });

  it("never defaults to a contractor, even a free one", () => {
    expect(plan([contractor()], {}).defaultCleanerId).toBeNull();
  });
});

describe("the options", () => {
  it("lists W-2 cleaners first, guaranteed hours first, then contractors", () => {
    const result = plan(
      [contractor({ id: "c-b", name: "B" }), iggy(), contractor({ id: "c-a", name: "A" }), shonda()],
      {},
    );
    expect(result.options.map((o) => o.cleaner.id)).toEqual(["shonda", "iggy", "c-a", "c-b"]);
  });

  it("offers contractors as assignable, and marks the ineligible with a reason", () => {
    const result = plan(
      [contractor(), contractor({ id: "c-x", name: "X", backgroundCheckCleared: false })],
      {},
    );
    expect(result.options[0]?.eligible).toBe(true);
    expect(result.options[1]?.reasons).toEqual(["background_not_cleared"]);
  });

  it("leaves out anyone who is not active", () => {
    const result = plan([shonda(), contractor({ status: "paused" })], {});
    expect(result.options.map((o) => o.cleaner.id)).toEqual(["shonda"]);
  });
});

describe("weekly hours", () => {
  it("counts the business week the job falls in, Monday to Monday", () => {
    // Thursday 10 Sep 2026, 10am in Dallas.
    const week = businessWeekOf(new Date("2026-09-10T15:00:00Z"));
    // Monday 7 Sep 00:00 CDT is 05:00 UTC.
    expect(week.start.toISOString()).toBe("2026-09-07T05:00:00.000Z");
    expect(week.end.toISOString()).toBe("2026-09-14T05:00:00.000Z");
  });

  it("treats Sunday night in Dallas as the end of that week, not the next", () => {
    // 01:00 UTC Monday 14 Sep is 8pm Sunday 13 Sep in Dallas.
    const week = businessWeekOf(new Date("2026-09-14T01:00:00Z"));
    expect(week.start.toISOString()).toBe("2026-09-07T05:00:00.000Z");
  });

  it("sums only that cleaner's work inside the week", () => {
    const week = businessWeekOf(new Date("2026-09-10T15:00:00Z"));
    const work = [
      { cleanerId: "shonda", start: new Date("2026-09-08T15:00:00Z"), end: new Date("2026-09-08T15:00:00Z"), minutes: 240, status: "assigned" },
      { cleanerId: "shonda", start: new Date("2026-09-12T15:00:00Z"), end: new Date("2026-09-12T15:00:00Z"), minutes: 120, status: "assigned" },
      { cleanerId: "shonda", start: new Date("2026-09-15T15:00:00Z"), end: new Date("2026-09-15T15:00:00Z"), minutes: 480, status: "assigned" }, // next week
      { cleanerId: "iggy", start: new Date("2026-09-09T15:00:00Z"), end: new Date("2026-09-09T15:00:00Z"), minutes: 600, status: "assigned" },
    ];
    expect(hoursInWeek(work, "shonda", week)).toBe(6);
  });
});
