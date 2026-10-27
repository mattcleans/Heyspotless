import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ profile: vi.fn(), admin: vi.fn(), release: vi.fn(), demo: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ({ getCurrentProfile: m.profile }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/billing/store", () => ({ BillingStore: class { releaseUnconfirmedPaymentOperation = m.release; } }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: m.demo }));
import { POST } from "./route";
const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const request = (body: unknown = { operationId: id, confirmedNoCharge: true }, headers: Record<string, string> = {}) =>
  new NextRequest("https://example.test/api/billing/release", { method: "POST", body: JSON.stringify(body), headers });
beforeEach(() => {
  vi.resetAllMocks(); m.profile.mockResolvedValue({ id: "staff", role: "admin" });
  m.demo.mockReturnValue(false); m.release.mockResolvedValue({ released: true, reason: null });
});
describe("office release of unconfirmed payment requests", () => {
  it.each([[null, 401], [{ id: "client", role: "customer" }, 403], [{ id: "cleaner", role: "cleaner" }, 403]])("refuses %j before privileged work", async (profile, status) => {
    m.profile.mockResolvedValue(profile);
    expect((await POST(request())).status).toBe(status);
    expect(m.admin).not.toHaveBeenCalled(); expect(m.release).not.toHaveBeenCalled();
  });
  it("is unavailable in demo mode", async () => {
    m.demo.mockReturnValue(true);
    expect((await POST(request())).status).toBe(503); expect(m.release).not.toHaveBeenCalled();
  });
  it("refuses a cross-site request", async () => {
    expect((await POST(request(undefined, { origin: "https://elsewhere.test" }))).status).toBe(403);
    expect(m.release).not.toHaveBeenCalled();
  });
  it.each([{ operationId: "untrusted", confirmedNoCharge: true }, { operationId: id }, { operationId: id, confirmedNoCharge: "yes" }])("requires a valid request and explicit Stripe confirmation %j", async (body) => {
    expect((await POST(request(body))).status).toBe(400); expect(m.release).not.toHaveBeenCalled();
  });
  it("releases as the signed-in Management profile", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ released: true, message: expect.stringContaining("new attempt") });
    expect(m.release).toHaveBeenCalledWith(id, "staff");
  });
  it.each([["too_recent", "Wait 30 minutes"], ["provider_reference", "Check payment status"], ["resolved", "already resolved"]])("explains a database refusal (%s)", async (reason, text) => {
    m.release.mockResolvedValue({ released: false, reason });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ released: false, message: expect.stringContaining(text) });
  });
  it("does not leak database errors", async () => {
    m.release.mockRejectedValue(new Error("private diagnostic"));
    const response = await POST(request());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private diagnostic");
  });
});
