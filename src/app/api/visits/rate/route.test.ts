import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ repo: vi.fn(), client: vi.fn(), admin: vi.fn(), rpc: vi.fn(), invoice: vi.fn(), billing: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: () => false }));
vi.mock("@/lib/stripe/env", () => ({ isBillingEnabled: m.billing }));
import { POST } from "./route";
const submit = (tipCents = 0) => POST(new NextRequest("https://example.test/api/visits/rate", {
  method: "POST", body: JSON.stringify({ jobId: "job", score: 5, tipCents }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  m.repo.mockResolvedValue({ getCurrentProfile: async () => ({ id: "profile", role: "customer" }) });
  m.client.mockResolvedValue({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "job" } }) }) }) }) });
  const query = { select: () => query, eq: () => query, is: () => query, order: () => query, limit: () => query, maybeSingle: m.invoice };
  m.admin.mockReturnValue({ rpc: m.rpc, from: () => query });
  m.rpc.mockImplementation(async (name: string) => ({ data: name === "record_rating_detailed" ? "rating" : "record", error: null }));
  m.invoice.mockResolvedValue({ data: { id: "invoice" } });
  m.billing.mockReturnValue(true);
});
describe("rating and tip outcomes", () => {
  it("saves a zero-tip rating while billing is disabled", async () => {
    m.billing.mockReturnValue(false);
    const response = await submit();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: true, tip: null });
    expect(m.rpc.mock.calls.map(c => c[0])).toEqual(["record_rating_detailed"]);
  });
  it("refuses tip writes when billing is disabled but keeps the rating", async () => {
    m.billing.mockReturnValue(false);
    const response = await submit(3980);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ recorded: true, tip: null, error: expect.stringContaining("no tip was added") });
    expect(m.invoice).not.toHaveBeenCalled();
    expect(m.rpc.mock.calls.map(c => c[0])).toEqual(["record_rating_detailed"]);
  });
  it("does not create a payout for a visit without an invoice", async () => {
    m.invoice.mockResolvedValue({ data: null });
    const response = await submit(3980);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ recorded: true, tip: null });
    expect(m.rpc.mock.calls.map(c => c[0])).toEqual(["record_rating_detailed"]);
  });
  it("does not create a payout when adding the tip to its invoice fails", async () => {
    m.rpc.mockImplementation(async (name: string) => ({ data: name === "record_rating_detailed" ? "rating" : null, error: name === "set_invoice_tip" ? { code: "check_violation" } : null }));
    const response = await submit(3980);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ recorded: true, tip: null });
    expect(m.rpc.mock.calls.map(c => c[0])).toEqual(["record_rating_detailed", "set_invoice_tip"]);
  });
  it("records the invoice before the payout and returns the recorded tip", async () => {
    const response = await submit(3980);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ recorded: true, tip: { tipCents: 3980 } });
    expect(m.rpc.mock.calls.map(c => c[0])).toEqual(["record_rating_detailed", "set_invoice_tip", "record_tip_payout"]);
  });
  it("refuses another role before reading or writing rating records", async () => {
    m.repo.mockResolvedValue({ getCurrentProfile: async () => ({ role: "cleaner" }) });
    expect((await submit()).status).toBe(403);
    expect(m.client).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
