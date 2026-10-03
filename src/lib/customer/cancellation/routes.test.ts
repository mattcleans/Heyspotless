import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({
  repo: vi.fn(),
  client: vi.fn(),
  rpc: vi.fn(),
  job: vi.fn(),
  customer: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
import { POST as clientCancel } from "@/app/api/customer/visits/[id]/cancel/route";
import { POST as officeCancel } from "@/app/api/admin/visits/[id]/cancel/route";
const jobId = "85000000-0000-0000-0000-000000000001",
  id = "88000000-0000-0000-0000-000000000001";
const raw = {
  id,
  job_id: jobId,
  reason: "cancel",
  scheduled_start: "2026-10-01T15:00:00Z",
  fee_cents: 6000,
  expires_at: "2026-10-01T10:05:00Z",
  invoice_id: "87000000-0000-0000-0000-000000000001",
  billing_review: false,
  canceled_at: "2026-10-01T10:00:00Z",
};
function account(role: string | null, demo = false) {
  m.repo.mockResolvedValue({
    isDemo: demo,
    getCurrentProfile: async () => (role ? { id: "profile", role } : null),
    getCustomerByProfile: m.customer,
    getJob: m.job,
  });
}
function post(body: unknown, office = false, visit = jobId) {
  return (office ? officeCancel : clientCancel)(
    new NextRequest("https://example.test/api/cancel", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: visit }) },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  account("customer");
  m.customer.mockResolvedValue({ id: "own" });
  m.job.mockResolvedValue({ id: jobId, customerId: "own" });
  m.client.mockResolvedValue({ rpc: m.rpc });
  m.rpc.mockResolvedValue({ data: raw, error: null });
});
describe("client-confirmed visit cancellations", () => {
  it.each([
    [null, 401],
    ["admin", 403],
    ["cleaner", 403],
  ] as const)(
    "rejects %s before visit reads or writes",
    async (role, status) => {
      account(role);
      expect((await post({ action: "review", reason: "cancel" })).status).toBe(
        status,
      );
      expect(m.job).not.toHaveBeenCalled();
      expect(m.rpc).not.toHaveBeenCalled();
    },
  );
  it("rejects preview mutations", async () => {
    account("customer", true);
    expect((await post({ action: "confirm", quoteId: id })).status).toBe(409);
    expect(m.client).not.toHaveBeenCalled();
  });
  it.each([null, { customerId: "other" }])(
    "rejects inaccessible visit %j",
    async (job) => {
      m.job.mockResolvedValue(job);
      expect((await post({ action: "review", reason: "cancel" })).status).toBe(
        404,
      );
      expect(m.rpc).not.toHaveBeenCalled();
    },
  );
  it("rejects unlinked client", async () => {
    m.customer.mockResolvedValue(null);
    expect((await post({ action: "review", reason: "cancel" })).status).toBe(
      403,
    );
    expect(m.job).not.toHaveBeenCalled();
  });
  it("rejects malformed visit ids", async () => {
    expect(
      (await post({ action: "review", reason: "cancel" }, false, "other"))
        .status,
    ).toBe(400);
    expect(m.job).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    {},
    { action: "review", reason: "free" },
    { action: "confirm", quoteId: "bad" },
    { action: "confirm", feeCents: 0 },
  ])("rejects malformed request %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("clients cannot record a door turnaway", async () => {
    expect(
      (await post({ action: "review", reason: "door_turnaway" })).status,
    ).toBe(403);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("quotes from the signed-in client, ignoring supplied customer/fee fields", async () => {
    const r = await post({
      action: "review",
      reason: "cancel",
      customerId: "other",
      feeCents: 0,
    });
    expect(r.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("quote_my_visit_cancellation", {
      p_job_id: jobId,
      p_reason: "cancel",
    });
    expect((await r.json()).quote.feeCents).toBe(6000);
  });
  it("confirmation uses the reviewed quote rather than a browser fee", async () => {
    const r = await post({ action: "confirm", quoteId: id, feeCents: 0 });
    expect(r.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("confirm_my_visit_cancellation", {
      p_job_id: jobId,
      p_quote_id: id,
    });
    expect((await r.json()).receipt).toMatchObject({
      id,
      jobId,
      feeCents: 6000,
      billingReview: false,
    });
  });
  it("cancels while flagging existing payments for office reconciliation", async () => {
    m.rpc.mockResolvedValue({
      data: { ...raw, billing_review: true, invoice_id: null },
      error: null,
    });
    expect(
      (await (await post({ action: "confirm", quoteId: id })).json()).receipt,
    ).toMatchObject({ billingReview: true, invoiceId: null });
  });
  it.each([
    ["PT409", 409],
    ["40001", 409],
    ["40P01", 409],
    ["42501", 403],
    ["23514", 409],
    ["22023", 400],
    ["08006", 500],
  ] as const)("returns safe recovery for database %s", async (code, status) => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code, message: "PRIVATE DETAILS" },
    });
    const r = await post({ action: "confirm", quoteId: id });
    expect(r.status).toBe(status);
    expect(JSON.stringify(await r.json())).not.toContain("PRIVATE DETAILS");
  });
  it.each([
    null,
    {},
    { ...raw, id: "wrong" },
    { ...raw, job_id: "85000000-0000-0000-0000-000000000009" },
    { ...raw, fee_cents: "6000" },
    { ...raw, fee_cents: 7000 },
    { ...raw, billing_review: "false" },
    { ...raw, invoice_id: null },
  ])("does not claim confirmation from invalid receipt %j", async (data) => {
    m.rpc.mockResolvedValue({ data, error: null });
    expect((await post({ action: "confirm", quoteId: id })).status).toBe(500);
  });
  it("office quotes require an admin and use their scoped session", async () => {
    expect(
      (await post({ action: "review", reason: "door_turnaway" }, true)).status,
    ).toBe(403);
    account("admin");
    m.rpc.mockResolvedValue({
      data: { ...raw, reason: "door_turnaway" },
      error: null,
    });
    expect(
      (await post({ action: "review", reason: "door_turnaway" }, true)).status,
    ).toBe(200);
    expect(m.customer).not.toHaveBeenCalled();
    expect(m.rpc).toHaveBeenCalledWith("quote_my_visit_cancellation", {
      p_job_id: jobId,
      p_reason: "door_turnaway",
    });
  });
});
