import { describe, expect, it } from "vitest";
import { dispatchBoard } from "./engine";
import { employeeWeekPlan } from "./employee-week-plan";
import { shonda, iggy } from "./fixtures";
import type { DispatchJob } from "./types";
describe("employee week forecasts", () => {
  it("keeps all employees and each week's proposed work separate", () => {
    const jobs: DispatchJob[] = [
      { id: "one", priceCents: 19900, zip: "75024", estimatedCleanMinutes: 60, scheduledStart: new Date("2026-10-09T16:00:00Z") },
      { id: "two", priceCents: 19900, zip: "75024", estimatedCleanMinutes: 60, scheduledStart: new Date("2026-10-12T16:00:00Z") },
    ];
    const ctx = { now: new Date("2026-10-08T15:00:00Z"), cleaners: [shonda(), iggy()],
      driveFor: () => ({ minutes: 0, miles: 0 }), scheduledHoursFor: (_: unknown, week: string) => week === "2026-10-05" ? 38 : 10 };
    const rows = employeeWeekPlan(dispatchBoard(jobs, ctx), ctx, 19900);
    expect(rows.map(r => r.week)).toEqual(["2026-10-05", "2026-10-12"]);
    expect(rows.map(r => r.employees.map(e => e.cleaner.id))).toEqual([["shonda", "iggy"], ["shonda", "iggy"]]);
    expect(rows.map(r => r.employees[0]?.forecast.totalHours)).toEqual([39, 11]);
    expect(rows.map(r => r.employees[0]?.guaranteeLeft)).toEqual([1, 29]);
    expect(rows.every(r => r.employees[0]?.proposedVisits === 1)).toBe(true);
  });
});
