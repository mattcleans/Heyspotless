import { describe, expect, it } from "vitest";
import { activeVisits, visitsOnDay, attentionVisits } from "./schedule";
import type { Job } from "@/lib/data/types";
const visit = (id: string, date: string | null, status = "assigned") =>
  ({ id, scheduledStart: date ? new Date(date) : null, status }) as Job;

describe("daily experience", () => {
  it("keeps the whole local day, without a four-visit limit or geographic reordering", () => {
    const jobs = Array.from({ length: 6 }, (_, i) =>
      visit(String(i), `2026-09-21T${String(13 + i).padStart(2, "0")}:00:00Z`),
    ).reverse();
    expect(
      visitsOnDay(jobs, new Date("2026-09-21T23:00:00Z")).map((j) => j.id),
    ).toEqual(["0", "1", "2", "3", "4", "5"]);
  });
  it("uses the market day across UTC midnight and excludes canceled visits", () => {
    const jobs = [
      visit("yesterday", "2026-09-21T04:59:00Z"),
      visit("today", "2026-09-22T04:59:00Z"),
      visit("tomorrow", "2026-09-22T05:00:00Z"),
      visit("canceled", "2026-09-21T15:00:00Z", "canceled"),
    ];
    expect(
      visitsOnDay(jobs, new Date("2026-09-21T15:00:00Z")).map((j) => j.id),
    ).toEqual(["today"]);
  });
  it("handles winter local-day boundaries and supports another market zone", () => {
    const jobs = [visit("late", "2026-12-22T05:30:00Z")];
    expect(visitsOnDay(jobs, new Date("2026-12-21T15:00:00Z"))).toHaveLength(1);
    expect(
      visitsOnDay(jobs, new Date("2026-12-21T15:00:00Z"), "America/New_York"),
    ).toHaveLength(0);
  });
  it("puts the ongoing visit first and unconfirmed times last without mutating input", () => {
    const jobs = [
      visit("unknown", null),
      visit("next", "2026-09-23T15:00:00Z"),
      visit("live", "2026-09-23T16:00:00Z", "in_progress"),
      visit("done", "2026-09-20T15:00:00Z", "complete"),
    ];
    expect(activeVisits(jobs).map((j) => j.id)).toEqual([
      "live",
      "next",
      "unknown",
    ]);
    expect(jobs[0]?.id).toBe("unknown");
  });
  it("flags missing times, late starts, and near-term unassigned work, not finished or ongoing work", () => {
    const jobs = [
      visit("missing", null),
      visit("late", "2026-09-21T13:00:00Z"),
      visit("unfilled", "2026-09-22T13:00:00Z", "scheduled"),
      visit("future", "2026-09-23T13:00:00Z", "dispatching"),
      visit("live", "2026-09-21T13:00:00Z", "in_progress"),
      visit("done", "2026-09-21T13:00:00Z", "complete"),
    ];
    expect(
      attentionVisits(jobs, new Date("2026-09-21T14:00:00Z")).map((j) => j.id),
    ).toEqual(["late", "unfilled", "missing"]);
  });
});
