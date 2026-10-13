vi.mock("@/lib/customer/recurring/store", () => ({
  recurringVisitChanges: async () => [],
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const m = vi.hoisted(() => ({
  repo: vi.fn(),
  client: vi.fn(),
  job: vi.fn(),
  customer: vi.fn(),
  visit: vi.fn(),
  history: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
vi.mock("./store", () => ({
  loadRescheduleVisit: m.visit,
  rescheduleHistory: m.history,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not-found");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
import { ReschedulePage } from "./page";
const id = "95000000-0000-0000-0000-000000000001";
function role(role: string | null, demo = false) {
  m.repo.mockResolvedValue({
    isDemo: demo,
    getCurrentProfile: async () => (role ? { id: "profile", role } : null),
    getCustomerByProfile: m.customer,
    getJob: m.job,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  role("customer");
  m.job.mockResolvedValue({
    id,
    customerId: "own",
    street: "Sample St",
    city: "Dallas",
    scheduledStart: new Date("2026-10-03T15:00Z"),
  });
  m.customer.mockResolvedValue({ id: "own" });
  m.client.mockResolvedValue({});
  m.visit.mockResolvedValue({ closed: false, recurring: true });
  m.history.mockResolvedValue([]);
});
describe("own appointment editing pages", () => {
  it.each([null, "admin", "cleaner"])(
    "%s never reads a client's visit",
    async (r) => {
      role(r);
      const html = renderToStaticMarkup(
        await ReschedulePage({ id, office: false }),
      );
      expect(html).toContain("Sign in to manage");
      expect(m.job).not.toHaveBeenCalled();
      expect(m.visit).not.toHaveBeenCalled();
    },
  );
  it("retains the requested date through a second sign-in link", async () => {
    role(null);
    const html = renderToStaticMarkup(
      await ReschedulePage({ id, office: false, start: "2026-10-04T10:30" }),
    );
    expect(decodeURIComponent(decodeURIComponent(html))).toContain(
      "start=2026-10-04T10:30",
    );
  });
  it("does not put an invalid return date into sign-in links", async () => {
    role(null);
    expect(
      renderToStaticMarkup(
        await ReschedulePage({
          id,
          office: false,
          start: "https://other.test",
        }),
      ),
    ).not.toContain("other.test");
  });
  it("rejects other clients before history reads", async () => {
    m.job.mockResolvedValue({ id, customerId: "other" });
    await expect(ReschedulePage({ id, office: false })).rejects.toThrow(
      "not-found",
    );
    expect(m.history).not.toHaveBeenCalled();
  });
  it("loads the requested visit and history through the session", async () => {
    await ReschedulePage({ id, office: false });
    expect(m.visit).toHaveBeenCalledWith({}, id);
    expect(m.history).toHaveBeenCalledWith({}, id);
  });
  it("management uses its own page and never requires a client linkage", async () => {
    role("admin");
    await ReschedulePage({ id, office: true });
    expect(m.customer).not.toHaveBeenCalled();
    expect(m.history).toHaveBeenCalled();
  });
});
