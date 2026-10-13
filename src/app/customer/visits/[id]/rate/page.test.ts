import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const m = vi.hoisted(() => ({ repo: vi.fn(), client: vi.fn(), eq: vi.fn(), rows: {} as Record<string, { data: unknown; error: unknown }> }));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: () => false }));
vi.mock("@/lib/stripe/env", () => ({ isBillingEnabled: () => false }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("not-found"); },
  useRouter: () => ({ refresh: vi.fn() }),
}));
import RateVisitPage from "./page";
const id = "a6666666-6666-4666-8666-666666666662";
const page = () => RateVisitPage({ params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.clearAllMocks();
  m.repo.mockResolvedValue({
    getCurrentProfile: async () => ({ id: "profile", role: "customer" }),
    getCustomerByProfile: async () => ({ id: "customer" }),
    getJob: async () => ({ id, customerId: "customer", status: "complete", service: "standard", priceCents: 19900 }),
  });
  m.rows = {
    jobs: { data: { completed_at: "2026-10-04T23:44:08Z" }, error: null },
    client_visit_assignments: { data: [{ full_name: "Preview Cleaner" }], error: null },
    ratings: { data: { score: "5.00", highlights: ["thorough"], private_note: "SYNTHETIC PREVIEW ONLY: saved note" }, error: null },
  };
  m.client.mockResolvedValue({ from: (table: string) => {
    type Query = { select: () => Query; eq: (column: string, value: unknown) => Query; maybeSingle: () => Promise<unknown>; limit: () => Promise<unknown> };
    const query: Query = {
      select: () => query,
      eq: (column, value) => { m.eq(table, column, value); return query; },
      maybeSingle: async () => m.rows[table],
      limit: async () => m.rows[table],
    };
    return query;
  } });
});
describe("saved Client rating page", () => {
  it("loads the Client's saved rating and the named assignment through scoped reads", async () => {
    const html = renderToStaticMarkup(await page());
    expect(html).toContain("How did Preview do?");
    expect(html).toContain("Saved rating: 5 out of 5");
    expect(html).toContain("SYNTHETIC PREVIEW ONLY: saved note");
    expect(m.eq).toHaveBeenCalledWith("ratings", "customer_id", "customer");
    expect(m.eq).toHaveBeenCalledWith("client_visit_assignments", "job_id", id);
    expect(m.eq).toHaveBeenCalledWith("client_visit_assignments", "is_lead", true);
  });
  it.each([null, "cleaner", "admin"])("rejects %s before opening a Client data connection", async (role) => {
    m.repo.mockResolvedValue({ getCurrentProfile: async () => role ? ({ id: "profile", role }) : null });
    await expect(page()).rejects.toThrow("not-found");
    expect(m.client).not.toHaveBeenCalled();
  });
  it("rejects a foreign visit before reading ratings or assignments", async () => {
    m.repo.mockResolvedValue({
      getCurrentProfile: async () => ({ id: "profile", role: "customer" }),
      getCustomerByProfile: async () => ({ id: "customer" }),
      getJob: async () => ({ id, customerId: "other", status: "complete" }),
    });
    await expect(page()).rejects.toThrow("not-found");
    expect(m.client).not.toHaveBeenCalled();
  });
  it("does not turn a failed rating read into an empty form", async () => {
    m.rows.ratings = { data: null, error: { code: "unavailable" } };
    await expect(page()).rejects.toThrow("Your rating could not be loaded");
  });
  it("does not pick a Cleaner from an ambiguous lead assignment", async () => {
    m.rows.client_visit_assignments = { data: [{ full_name: "First" }, { full_name: "Second" }], error: null };
    await expect(page()).rejects.toThrow("Your cleaner assignment needs review");
  });
  it("renders an empty form only when there is no saved rating", async () => {
    m.rows.ratings = { data: null, error: null };
    const html = renderToStaticMarkup(await page());
    expect(html).toContain("How did Preview do?");
    expect(html).not.toContain("Saved rating");
  });
});
