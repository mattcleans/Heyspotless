import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Job } from "@/lib/data/types";

const m = vi.hoisted(() => ({ repo: vi.fn(), payouts: vi.fn(), scope: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ eq: m.scope }) }),
  }),
}));
vi.mock("@/lib/customer/reschedule/store", () => ({ releasedVisits: async () => [] }));
vi.mock("@/lib/crew/store", () => ({ myCrewOffers: async () => [] }));
vi.mock("./push-prompt", () => ({ PushPrompt: () => null }));
import CleanerHome from "./page";

const visit = (id: string, start: string | null, status = "assigned") =>
  ({ id, customerName: id, street: "Synthetic Preview Way", city: "Dallas",
    service: "standard", bedrooms: 2, bathrooms: 2, estimatedCleanMinutes: 120,
    scheduledStart: start ? new Date(start) : null, status }) as Job;
function jobs(records: Job[]) {
  m.repo.mockResolvedValue({
    isDemo: false,
    getCurrentProfile: async () => ({ id: "cleaner-profile" }),
    getCleanerByProfile: async () => ({ id: "own-cleaner", name: "Cleaner", type: "contractor" }),
    listJobs: async () => records,
    listLiveOffers: async () => [],
  });
  m.payouts.mockResolvedValue({
    data: records.map(j => ({ job_id: j.id, payout_cents: 6965 })), error: null,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Already Oct 5 in UTC; Dallas is still Oct 4.
  vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
  m.scope.mockReturnValue({ in: m.payouts });
});
afterEach(() => vi.useRealTimers());

describe("cleaner home ongoing visits", () => {
  it("keeps yesterday's ongoing clean above today's assignment with its own agreed pay", async () => {
    jobs([visit("today", "2026-10-05T01:00:00Z"), visit("ongoing", "2026-10-03T23:30:00Z", "in_progress")]);
    const html = renderToStaticMarkup(await CleanerHome());
    expect(html).toContain("Continue your clean below.");
    expect(html).toContain("Continue this clean");
    expect(html).toContain("$69.65 agreed pay");
    expect(html.indexOf('href="/cleaner/job/ongoing"')).toBeLessThan(html.indexOf('href="/cleaner/job/today"'));
    expect(html).not.toContain("A clear day ahead");
    expect(m.scope).toHaveBeenCalledWith("cleaner_id", "own-cleaner");
    expect(m.payouts).toHaveBeenCalledWith("job_id", ["ongoing", "today"]);
  });
  it("preserves an ongoing clean even when its appointment time is missing", async () => {
    jobs([visit("untimed", null, "in_progress")]);
    const html = renderToStaticMarkup(await CleanerHome());
    expect(html).toContain("Time to be confirmed");
    expect(html).toContain('href="/cleaner/job/untimed"');
    expect(html).toContain("Continue this clean");
    expect(html).not.toContain("A clear day ahead");
  });
  it("prioritizes today's ongoing clean without duplicating its card", async () => {
    jobs([visit("earlier-assigned", "2026-10-04T15:00:00Z"), visit("today-active", "2026-10-04T18:00:00Z", "in_progress")]);
    const html = renderToStaticMarkup(await CleanerHome());
    expect(html.indexOf('href="/cleaner/job/today-active"')).toBeLessThan(html.indexOf('href="/cleaner/job/earlier-assigned"'));
    expect(html.match(/href="\/cleaner\/job\/today-active"/g)).toHaveLength(1);
    expect(html).toContain("Today’s visits");
  });
  it("shows an ongoing visit once even if its saved appointment is on a future day", async () => {
    jobs([visit("future-active", "2026-10-06T15:00:00Z", "in_progress")]);
    const html = renderToStaticMarkup(await CleanerHome());
    expect(html.match(/href="\/cleaner\/job\/future-active"/g)).toHaveLength(1);
    expect(html).toContain("Continue this clean");
  });
  it("keeps the clear-day state when there is no ongoing clean or visit on the Dallas day", async () => {
    jobs([visit("past-assigned", "2026-10-03T23:30:00Z")]);
    const html = renderToStaticMarkup(await CleanerHome());
    expect(html).toContain("A clear day ahead");
    expect(html).not.toContain("Continue this clean");
    expect(m.payouts).not.toHaveBeenCalled();
  });
});
