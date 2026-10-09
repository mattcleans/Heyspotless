import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Job } from "@/lib/data/types";

const m = vi.hoisted(() => ({ repo: vi.fn(), visit: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: () => false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/visits/customer-visit-store", () => ({ loadCustomerVisit: m.visit }));
vi.mock("@/lib/cleaners/store", () => ({ CleanerDirectory: class { get = async () => null; } }));
import ClientHome from "./page";

const visit = (id: string, date: string | null, status = "assigned") =>
  ({ id, scheduledStart: date ? new Date(date) : null, status,
    service: "standard", bedrooms: 2, bathrooms: 2 }) as Job;
function jobs(records: Job[]) {
  m.repo.mockResolvedValue({
    isDemo: false,
    getCurrentProfile: async () => ({ id: "client" }),
    getCustomerByProfile: async () => ({ id: "customer", firstName: "Client" }),
    listProperties: async () => [],
    listJobs: async () => records,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // UTC is already Oct 5; Dallas is still Oct 4.
  vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
  m.visit.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe("client home visit selection", () => {
  it("shows the upcoming backup instead of a past unfinished visit and preserves both links", async () => {
    jobs([visit("past", "2026-10-04T20:00:00Z"), visit("next", "2026-10-05T01:00:00Z")]);
    m.visit.mockResolvedValue({
      summary: { stage: "accepted" },
      backup: { approved: false, declined: false },
      cleanerName: "Backup",
    });
    const html = renderToStaticMarkup(await ClientHome());
    expect(m.visit).toHaveBeenCalledWith({}, "next");
    expect(html).toContain("Your next visit");
    expect(html).toContain("Review backup cleaner");
    expect(html).toContain('href="/customer/visits/next/cleaner"');
    expect(html).toContain("Past visits to check");
    expect(html).toContain('href="/customer/visits/past"');
  });
  it("prioritizes an ongoing clean and labels it as in progress", async () => {
    jobs([visit("future", "2026-10-05T01:00:00Z"), visit("live", "2026-10-04T20:00:00Z", "in_progress")]);
    const html = renderToStaticMarkup(await ClientHome());
    expect(m.visit).toHaveBeenCalledWith({}, "live");
    expect(html).toContain("Your clean in progress");
    expect(html).toContain("Follow your clean");
    expect(html).not.toContain("Past visits to check");
    expect(html).not.toContain("Your next visit");
  });
  it("keeps overdue work visible without claiming a future booking when none exists", async () => {
    jobs([visit("past", "2026-10-04T20:00:00Z"), visit("canceled", "2026-10-05T01:00:00Z", "canceled")]);
    const html = renderToStaticMarkup(await ClientHome());
    expect(m.visit).not.toHaveBeenCalled();
    expect(html).toContain("Past visits to check");
    expect(html).toContain('href="/customer/visits/past"');
    expect(html).not.toContain("Your next visit");
    expect(html).not.toContain('href="/customer/visits/canceled"');
  });
  it("still shows an unscheduled active visit when no ongoing or future appointment exists", async () => {
    jobs([visit("past", "2026-10-04T20:00:00Z"), visit("untimed", null, "unscheduled")]);
    const html = renderToStaticMarkup(await ClientHome());
    expect(m.visit).toHaveBeenCalledWith({}, "untimed");
    expect(html).toContain("Time to be confirmed");
    expect(html).toContain('href="/customer/visits/untimed"');
    expect(html).toContain("Past visits to check");
  });
});
