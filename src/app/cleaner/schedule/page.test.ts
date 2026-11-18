import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const m = vi.hoisted(() => ({ repo: vi.fn(), client: vi.fn(), history: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
vi.mock("@/lib/cleaners/assignment-history", async original => ({ ...await original<object>(), loadAssignmentHistory: m.history }));
vi.mock("@/components/visit-sections", () => ({ VisitSections: () => "CURRENT ASSIGNED VISITS" }));
import Page from "./page";
const changes = [{ key: "old", kind: "schedule", previousStart: "2026-10-20T15:00:00Z", newStart: "2026-10-21T16:00:00Z", releasedAt: "2026-10-15T20:20:41Z", agreedCents: 7392 }];
function repo(type = "contractor_1099", linked = true, isDemo = false) {
  m.repo.mockResolvedValue({ isDemo, getCurrentProfile: async () => ({ id: "profile" }), getCleanerByProfile: async () => linked ? { id: "mine", type } : null, listJobs: async () => [{ id: "current" }] });
}
beforeEach(() => { vi.clearAllMocks(); repo(); m.client.mockResolvedValue("request-client"); m.history.mockResolvedValue(changes); });
const render = async () => renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
describe("schedule assignment history", () => {
  it("keeps current assignments and earlier contractor agreements distinct", async () => {
    const html = await render();
    expect(m.history).toHaveBeenCalledWith("request-client", "mine", true);
    expect(html).toContain("CURRENT ASSIGNED VISITS"); expect(html).toContain("$73.92"); expect(html).toContain("not a payment record");
    expect(html).toContain("2026"); expect(html).toContain("10:00 AM"); expect(html).toContain("11:00 AM");
    expect(html).toContain("does not assign you to that time"); expect(html).not.toContain("/cleaner/job/old");
  });
  it("keeps current assignments available when history fails", async () => {
    m.history.mockRejectedValue(new Error("private database detail")); const html = await render();
    expect(html).toContain("CURRENT ASSIGNED VISITS"); expect(html).toContain('role="alert"'); expect(html).toContain("Reload schedule");
    expect(html).not.toContain("No assignment releases"); expect(html).not.toContain("private database detail");
  });
  it("does not present former contractor pay to hourly employees", async () => {
    repo("w2_core"); const html = await render();
    expect(m.history).toHaveBeenCalledWith("request-client", "mine", false); expect(html).not.toContain("$73.92");
  });
  it.each([false, true])("does not fetch history for an unlinked account or demo: %s", async demo => {
    repo("contractor_1099", demo, demo); const html = await render();
    expect(m.history).not.toHaveBeenCalled(); expect(m.client).not.toHaveBeenCalled(); expect(html).not.toContain("Changes to your assignments");
  });
  it("does not invent pay for crew changes without a retained pay snapshot", async () => {
    m.history.mockResolvedValue([{ ...changes[0], kind: "crew", agreedCents: null, newStart: null }]);
    const html = await render(); expect(html).toContain("crew change"); expect(html).toContain("Confirm with the office"); expect(html).not.toContain("$0.00");
  });
});
