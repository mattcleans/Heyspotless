import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { shonda } from "@/lib/dispatch/fixtures";
const m = vi.hoisted(() => ({ repo: vi.fn(), client: vi.fn(), calendar: vi.fn(), jobs: vi.fn(), cleaners: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
vi.mock("@/lib/dispatch/calendar-context", () => ({ matchingCalendarInputs: m.calendar }));
import Page from "./page";
function account(role: string | null, demo = false) {
  m.repo.mockResolvedValue({ isDemo: demo, getCurrentProfile: async () => role ? { role } : null,
    listJobs: m.jobs, listCleaners: m.cleaners });
}
beforeEach(() => {
  vi.clearAllMocks(); account("admin");
  m.jobs.mockResolvedValue([{ id: "future", customerId: "client", propertyId: "home", customerName: "Synthetic Client",
    street: "Synthetic Home", city: "Dallas", zip: "75024", bedrooms: 2, bathrooms: 2,
    status: "scheduled", service: "standard", frequency: "one_time", priceCents: 19900,
    estimatedCleanMinutes: 30, scheduledStart: new Date(Date.now() + 86400000) }]);
  m.cleaners.mockResolvedValue([shonda({ hoursScheduledThisWeek: 0 })]);
  m.client.mockResolvedValue({});
  m.calendar.mockResolvedValue({ eligibilityFor: () => ({ workingWindows: [] }) });
});
describe("Management matching uses the saved calendar", () => {
  it.each([null, "customer", "cleaner"])("does not read matching data for %s", async role => {
    account(role);
    expect(renderToStaticMarkup(await Page())).toContain("Management account");
    expect(m.jobs).not.toHaveBeenCalled(); expect(m.cleaners).not.toHaveBeenCalled();
    expect(m.client).not.toHaveBeenCalled(); expect(m.calendar).not.toHaveBeenCalled();
  });
  it("does not suggest or label an employee eligible on a declared unavailable day", async () => {
    const html = renderToStaticMarkup(await Page());
    expect(m.calendar).toHaveBeenCalledOnce();
    expect(html).toContain("No eligible cleaner in this plan");
    expect(html).toContain("Outside the hours they work");
    expect(html).not.toContain("Consider Shonda");
  });
  it("links the unresolved assignment that prevents a recommendation", async () => {
    m.calendar.mockResolvedValue({ eligibilityFor: () => ({
      busyWindows: [{ start: new Date(), end: new Date(Date.now() + 86400000),
        requiresReview: true, jobId: "saved-assignment-visit" }],
    }) });
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("Existing assignment time needs review");
    expect(html).toContain('href="/admin/visits/saved-assignment-visit"');
    expect(html).not.toContain("Consider Shonda");
  });
  it("preserves a calendar read failure for the workspace recovery screen", async () => {
    m.calendar.mockRejectedValue(new Error("Calendar temporarily unavailable"));
    await expect(Page()).rejects.toThrow("Calendar temporarily unavailable");
  });
  it("does not query a live calendar for a demo roster", async () => {
    account(null, true);
    await Page();
    expect(m.client).not.toHaveBeenCalled(); expect(m.calendar).not.toHaveBeenCalled();
  });
});

