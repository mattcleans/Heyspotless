import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({
  repo: vi.fn(),
  client: vi.fn(),
  admin: vi.fn(),
  load: vi.fn(),
  reconcile: vi.fn(),
  rpc: vi.fn(),
  job: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("./store", () => ({ loadCancellation: m.load }));
vi.mock("@/lib/billing/store", () => ({ BillingStore: class {} }));
vi.mock("@/lib/billing/collection", () => ({
  reconcileInvoiceCollection: m.reconcile,
}));
import { POST } from "@/app/api/admin/visits/[id]/resolve-cancellation/route";
const jobId = "85000000-0000-0000-0000-000000000001",
  id = "88000000-0000-0000-0000-000000000001",
  invoiceId = "87000000-0000-0000-0000-000000000001";
const receipt = {
  id,
  job_id: jobId,
  reason: "cancel",
  scheduled_start: null,
  fee_cents: 6000,
  invoice_id: invoiceId,
  billing_review: false,
  canceled_at: "2026-10-01T15:00:00Z",
};
function account(role: string | null, demo = false) {
  m.repo.mockResolvedValue({
    isDemo: demo,
    getCurrentProfile: async () => (role ? { id: "profile", role } : null),
    getJob: m.job,
  });
}
function post(body: unknown = { cancellationId: id }) {
  return POST(
    new NextRequest("https://example.test/api/resolve-cancellation", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: jobId }) },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  account("admin");
  m.job.mockResolvedValue({ id: jobId });
  m.load.mockResolvedValue({ id, jobId, billingReview: true });
  m.reconcile.mockResolvedValue({ state: "cleared" });
  const q: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) q[method] = () => q;
  q.then = (resolve: (v: unknown) => void) =>
    resolve({ data: [{ id: invoiceId }], error: null });
  m.client.mockResolvedValue({ from: () => q, rpc: m.rpc });
  m.rpc.mockResolvedValue({ data: receipt, error: null });
});
describe("office cancellation billing resolution", () => {
  it.each([
    [null, 401],
    ["customer", 403],
    ["cleaner", 403],
  ] as const)(
    "rejects %s before reading billing records",
    async (role, status) => {
      account(role);
      expect((await post()).status).toBe(status);
      expect(m.client).not.toHaveBeenCalled();
      expect(m.admin).not.toHaveBeenCalled();
    },
  );
  it("rejects preview billing changes", async () => {
    account("admin", true);
    expect((await post()).status).toBe(409);
    expect(m.admin).not.toHaveBeenCalled();
  });
  it.each([null, {}, { cancellationId: "bad" }])(
    "rejects malformed input %j",
    async (body) => {
      expect((await post(body)).status).toBe(400);
      expect(m.job).not.toHaveBeenCalled();
    },
  );
  it("rejects an inaccessible job", async () => {
    m.job.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(m.load).not.toHaveBeenCalled();
  });
  it("rejects a different receipt before provider reads", async () => {
    m.load.mockResolvedValue({ id: "other" });
    expect((await post()).status).toBe(409);
    expect(m.admin).not.toHaveBeenCalled();
  });
  it("keeps review pending while a provider payment is in flight", async () => {
    m.reconcile.mockResolvedValue({ state: "in_flight" });
    expect((await post()).status).toBe(409);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("requires database-confirmed refund resolution before claiming a fee invoice", async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: "40001", message: "PRIVATE DETAILS" },
    });
    const r = await post();
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).toContain("fully refunded");
    expect(JSON.stringify(await (await post()).json())).not.toContain("PRIVATE DETAILS");
  });
  it("reconciles only the visit's invoices then calls the role-checked billing RPC", async () => {
    const r = await post();
    expect(r.status).toBe(200);
    expect(m.reconcile).toHaveBeenCalledWith(expect.anything(), invoiceId);
    expect(m.rpc).toHaveBeenCalledWith("resolve_visit_cancellation_billing", {
      p_job_id: jobId,
      p_cancellation_id: id,
    });
    expect((await r.json()).resolved).toBe(true);
  });
  it("idempotent retries need no more provider reads after resolution", async () => {
    m.load.mockResolvedValue({ id, jobId, billingReview: false });
    expect((await post()).status).toBe(200);
    expect(m.reconcile).not.toHaveBeenCalled();
    expect(m.admin).not.toHaveBeenCalled();
  });
  it("unknown or still-pending receipt is never claimed as resolved", async () => {
    m.rpc.mockResolvedValue({
      data: { ...receipt, billing_review: true, invoice_id: null },
      error: null,
    });
    expect((await post()).status).toBe(503);
  });
  it("provider outage leaves billing review pending", async () => {
    m.reconcile.mockRejectedValue(new Error("provider private detail"));
    expect((await post()).status).toBe(503);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
