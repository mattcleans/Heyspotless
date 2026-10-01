import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const m = vi.hoisted(() => ({
  repo: vi.fn(),
  client: vi.fn(),
  load: vi.fn(),
  directory: vi.fn(),
  selected: vi.fn(),
  job: vi.fn(),
  home: vi.fn(),
  customer: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
vi.mock("@/lib/customer/cleaner-choice/store", () => ({
  loadVisitChoice: m.load,
}));
vi.mock("@/lib/cleaners/store", () => ({
  CleanerDirectory: class {
    servingZip = m.directory;
    get = m.selected;
  },
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not-found");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
import Page from "./page";
const id = "95000000-0000-0000-0000-000000000001",
  selected = "94000000-0000-0000-0000-000000000001";
function account(role: string | null) {
  m.repo.mockResolvedValue({
    isDemo: false,
    getCurrentProfile: async () => (role ? { id: "self", role } : null),
    getCustomerByProfile: m.customer,
    getJob: m.job,
    getProperty: m.home,
  });
}
const page = (visit = id, preferred?: string) =>
  Page({
    params: Promise.resolve({ id: visit }),
    searchParams: Promise.resolve({ preferred }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  account("customer");
  m.customer.mockResolvedValue({ id: "own" });
  m.job.mockResolvedValue({ customerId: "own", propertyId: "home" });
  m.home.mockResolvedValue({ street: "Sample", city: "Dallas", zip: "75001" });
  m.client.mockResolvedValue({});
  m.load.mockResolvedValue({
    status: "scheduled",
    started: false,
    preferredCleanerId: null,
    assigned: null,
    request: null,
    backup: null,
  });
  m.directory.mockResolvedValue([]);
  m.selected.mockResolvedValue({
    id: selected,
    fullName: "Selected Cleaner",
    serviceZips: ["75001"],
  });
});
describe("client cleaner page ownership and profile selection", () => {
  it.each([null, "admin", "cleaner"])(
    "rejects %s before visit/home reads",
    async (role) => {
      account(role);
      expect(renderToStaticMarkup(await page())).toContain(
        "Sign in with your client account",
      );
      expect(m.job).not.toHaveBeenCalled();
      expect(m.client).not.toHaveBeenCalled();
    },
  );
  it("rejects malformed visit IDs before reads", async () => {
    await expect(page("bad")).rejects.toThrow("not-found");
    expect(m.job).not.toHaveBeenCalled();
  });
  it.each([null, { customerId: "other", propertyId: "other-home" }])(
    "rejects inaccessible visit %j before reading its home",
    async (job) => {
      m.job.mockResolvedValue(job);
      await expect(page()).rejects.toThrow("not-found");
      expect(m.home).not.toHaveBeenCalled();
      expect(m.load).not.toHaveBeenCalled();
    },
  );
  it("rejects unlinked client profiles", async () => {
    m.customer.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("not-found");
    expect(m.home).not.toHaveBeenCalled();
  });
  it("filters the bounded directory by this visit's home ZIP", async () => {
    await page();
    expect(m.directory).toHaveBeenCalledWith("75001", 24);
  });
  it("carries a requested public profile through to the preference form", async () => {
    const html = renderToStaticMarkup(await page(id, selected));
    expect(html).toContain('value="' + selected + '" selected=""');
    expect(m.selected).toHaveBeenCalledWith(selected);
  });
  it("does not offer a selected profile outside the home's service area", async () => {
    m.selected.mockResolvedValue({
      id: selected,
      fullName: "Outside",
      serviceZips: ["99999"],
    });
    expect(renderToStaticMarkup(await page(id, selected))).not.toContain(
      "Outside",
    );
  });
  it("does not read a malformed selected profile", async () => {
    await page(id, "bad");
    expect(m.selected).not.toHaveBeenCalled();
  });
  it("does not fabricate choices when the read fails", async () => {
    m.load.mockRejectedValue(new Error("unavailable"));
    await expect(page()).rejects.toThrow("unavailable");
    expect(m.directory).not.toHaveBeenCalled();
  });
});
