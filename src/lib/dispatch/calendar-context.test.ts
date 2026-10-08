import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { busyWindowsFor } from "./store";
import { matchingCalendarInputs } from "./calendar-context";
import { checkEligibility } from "./eligibility";
import { contractor } from "./fixtures";
import type { DispatchJob } from "./types";
const now = new Date("2026-10-08T15:00:00Z");
const job: DispatchJob = { id: "visit", priceCents: 19900, zip: "75024",
  estimatedCleanMinutes: 30, scheduledStart: new Date("2026-10-08T15:30:00Z") };
const records = [
  { id: "da000000-0000-4000-8000-000000000001", cleaner_id: "busy",
    jobs: { scheduled_start: "2026-10-08T14:00:00Z", scheduled_end: "2026-10-08T17:00:00Z", estimated_clean_minutes: 30, status: "in_progress" } },
  { id: "da000000-0000-4000-8000-000000000002", cleaner_id: "needs-review",
    jobs: { scheduled_start: null, scheduled_end: null, estimated_clean_minutes: 90, status: "assigned" } },
  { id: "da000000-0000-4000-8000-000000000003", cleaner_id: "finished-window",
    jobs: { scheduled_start: "2026-10-07T14:00:00Z", scheduled_end: "2026-10-07T15:00:00Z", estimated_clean_minutes: 30, status: "assigned" } },
];
function api(failAssignments = false) {
  const urls: URL[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(url);
    if (url.pathname.endsWith("/job_assignments")) {
      if (failAssignments) return new Response(JSON.stringify({ code: "42501", message: "Denied" }), { status: 403 });
      const cursor = url.searchParams.get("id")?.replace(/^gt\./, "");
      // Simulate a server row cap LOWER than the requested 200: every short
      // page must still advance until an empty page confirms the end.
      return new Response(JSON.stringify(records.filter(r => !cursor || r.id > cursor).slice(0, 1)), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify([
      { cleaner_id: "busy", day_of_week: 4, starts_at: "09:00:00", ends_at: "17:00:00" },
      { cleaner_id: "off-day", day_of_week: 5, starts_at: "09:00:00", ends_at: "17:00:00" },
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { urls, db: createClient("https://calendar.example.test", "synthetic-calendar-key",
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher } }) };
}
describe("saved matching calendar via the actual Supabase query builder", () => {
  it("includes an overlapping visit that began earlier and completes all capped pages", async () => {
    const { db, urls } = api();
    const calendar = await busyWindowsFor(db, now, new Date("2026-10-08T18:00:00Z"));
    expect(calendar.get("busy")?.[0]?.start.toISOString()).toBe("2026-10-08T14:00:00.000Z");
    expect(calendar.get("busy")?.[0]?.end.toISOString()).toBe("2026-10-08T17:00:00.000Z");
    expect(calendar.get("needs-review")?.[0]?.requiresReview).toBe(true);
    expect(calendar.has("finished-window")).toBe(false);
    expect(urls).toHaveLength(4);
    expect(urls[0]?.searchParams.get("jobs.or")).toContain("scheduled_start.lte.");
    expect(urls[0]?.searchParams.has("jobs.scheduled_start")).toBe(false);
  });
  it("honors saved bookings, declared off-days and unknown declarations separately", async () => {
    const { db } = api();
    const ctx = await matchingCalendarInputs(db, [job], now);
    expect(checkEligibility(contractor({ id: "busy" }), job, ctx.eligibilityFor?.(contractor({ id: "busy" }), job)).reasons).toContain("already_booked");
    expect(checkEligibility(contractor({ id: "off-day" }), job, ctx.eligibilityFor?.(contractor({ id: "off-day" }), job)).reasons).toContain("outside_working_hours");
    expect(checkEligibility(contractor({ id: "needs-review" }), job, ctx.eligibilityFor?.(contractor({ id: "needs-review" }), job)).reasons).toContain("assignment_time_unavailable");
    expect(checkEligibility(contractor({ id: "unknown" }), job, ctx.eligibilityFor?.(contractor({ id: "unknown" }), job)).eligible).toBe(true);
  });
  it("does not substitute a free calendar when the saved assignments read is denied", async () => {
    const { db } = api(true);
    await expect(matchingCalendarInputs(db, [job], now)).rejects.toThrow("Matching assignment calendar unavailable");
  });
});
