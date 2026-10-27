import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ profile: vi.fn(), invoice: vi.fn(), admin: vi.fn(), reconcile: vi.fn(), billing: vi.fn(), demo: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ({ getCurrentProfile: m.profile, getInvoice: m.invoice }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/billing/store", () => ({ BillingStore: class {} }));
vi.mock("@/lib/billing/collection", () => ({ reconcileInvoiceCollection: m.reconcile }));
vi.mock("@/lib/stripe/env", () => ({ isBillingEnabled: m.billing }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: m.demo }));
import { POST } from "./route";
const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const request = (body: unknown = { invoiceId: id }) => new NextRequest("https://example.test/api/billing/reconcile", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks(); m.profile.mockResolvedValue({ id: "staff", role: "admin" });
  m.billing.mockReturnValue(true); m.demo.mockReturnValue(false); m.invoice.mockResolvedValue({ id });
  m.reconcile.mockResolvedValue({ state: "in_flight", reviewRequired: true });
});
describe("office status-check authority", () => {
  it.each([[null, 401], [{ role: "customer" }, 403], [{ role: "cleaner" }, 403]])("refuses %j before privileged work", async (profile, status) => {
    m.profile.mockResolvedValue(profile);
    expect((await POST(request())).status).toBe(status);
    expect(m.admin).not.toHaveBeenCalled(); expect(m.invoice).not.toHaveBeenCalled(); expect(m.reconcile).not.toHaveBeenCalled();
  });
  it.each(["disabled", "demo"])("does not call Stripe in %s mode", async mode => {
    m.billing.mockReturnValue(mode !== "disabled"); m.demo.mockReturnValue(mode === "demo");
    expect((await POST(request())).status).toBe(503);
    expect(m.admin).not.toHaveBeenCalled(); expect(m.reconcile).not.toHaveBeenCalled();
  });
  it("requires an invoice read through the signed-in repository", async () => {
    m.invoice.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(404); expect(m.admin).not.toHaveBeenCalled();
  });
  it("rejects malformed IDs without a privileged writer", async () => {
    expect((await POST(request({ invoiceId: "untrusted" }))).status).toBe(400); expect(m.admin).not.toHaveBeenCalled();
  });
  it("does not accept a caller's request to mark an unknown operation paid", async () => {
    const response = await POST(request({ invoiceId: id, state: "settled", amountCents: 1 }));
    expect(await response.json()).toMatchObject({ state: "in_flight", reviewRequired: true, message: expect.stringContaining("Keep this request on hold") });
    expect(m.reconcile).toHaveBeenCalledWith(expect.anything(), id);
  });
  it("records the reconciliation result without claiming the whole bill is paid", async () => {
    m.reconcile.mockResolvedValue({ state: "settled" });
    expect(await (await POST(request())).json()).toMatchObject({ message: expect.stringContaining("latest invoice balance") });
  });
  it("does not clear an unknown outcome or leak provider errors", async () => {
    m.reconcile.mockRejectedValue(new Error("provider private diagnostic"));
    const response = await POST(request());
    expect(response.status).toBe(503); const text = await response.text();
    expect(text).toContain("could not be confirmed"); expect(text).not.toContain("private diagnostic");
  });
});
