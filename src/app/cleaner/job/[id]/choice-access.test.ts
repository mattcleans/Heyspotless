import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const m = vi.hoisted(() => ({
  repo: vi.fn(),
  client: vi.fn(),
  admin: vi.fn(),
  photos: vi.fn(),
  job: vi.fn(),
  property: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/service/store", () => ({
  ServiceStore: class {
    photosFor = m.photos;
  },
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not-found");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
import Page from "./page";
const id = "95000000-0000-0000-0000-000000000001";
let assignment: { data: unknown; error: unknown },
  approval: { data: unknown; error: unknown };
function account(role: string | null) {
  m.repo.mockResolvedValue({
    isDemo: false,
    getCurrentProfile: async () => (role ? { id: "self", role } : null),
    getCleanerByProfile: async () => ({
      id: "cleaner",
      type: "contractor_1099",
    }),
    getJob: m.job,
    getProperty: m.property,
  });
}
const page = () => Page({ params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.clearAllMocks();
  account("cleaner");
  assignment = { data: { id: "assignment", payout_cents: 8000 }, error: null };
  approval = { data: [{ approved: false, unambiguous: true }], error: null };
  m.client.mockResolvedValue({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const f of ["select", "eq", "limit", "maybeSingle"]) q[f] = () => q;
      q.then = (resolve: (v: unknown) => void) =>
        resolve(table === "job_assignments" ? assignment : approval);
      return q;
    },
  });
  m.job.mockResolvedValue({
    id,
    status: "assigned",
    propertyId: "home",
    bedrooms: 1,
    bathrooms: 1,
    street: "Sample",
    city: "Dallas",
    customerName: "Client",
    scheduledStart: null,
    estimatedCleanMinutes: 60,
  });
  m.property.mockResolvedValue({
    rooms: { bedrooms: 1, bathrooms: 1 },
    gateCode: "private-gate",
  });
  m.photos.mockResolvedValue([]);
});
describe("assigned cleaner consent gate", () => {
  it.each([null, "customer", "admin"])(
    "denies %s before job, home or private photo reads",
    async (role) => {
      account(role);
      expect(renderToStaticMarkup(await page())).toContain(
        "Sign in as your assigned cleaner",
      );
      expect(m.job).not.toHaveBeenCalled();
      expect(m.admin).not.toHaveBeenCalled();
    },
  );
  it("does not reveal home instructions or private photos for a board job without assignment", async () => {
    assignment.data = null;
    await expect(page()).rejects.toThrow("not-found");
    expect(m.property).not.toHaveBeenCalled();
    expect(m.admin).not.toHaveBeenCalled();
  });
  it("fails safely if approval status cannot be read", async () => {
    approval.error = { message: "denied" };
    await expect(page()).rejects.toThrow("Unable to check client approval");
    expect(m.photos).not.toHaveBeenCalled();
  });
  it("withholds arrival and on-my-way buttons while waiting for approval", async () => {
    const html = renderToStaticMarkup(await page());
    expect(html).toContain("Waiting for client approval");
    expect(html).not.toContain("I&#x27;ve arrived");
    expect(html).not.toContain("On my way</button>");
    expect(html).toContain("private-gate");
  });
  it("allows start controls after authoritative current approval", async () => {
    approval.data = [{ approved: true, unambiguous: true }];
    const html = renderToStaticMarkup(await page());
    expect(html).toContain("I&#x27;ve arrived");
    expect(html).not.toContain("Waiting for client approval");
  });
  it("does not retroactively block work already in progress", async () => {
    m.job.mockResolvedValue({ ...(await m.job()), status: "in_progress" });
    const html = renderToStaticMarkup(await page());
    expect(html).toContain("Done</button>");
    expect(html).not.toContain("Waiting for client approval");
  });
});
