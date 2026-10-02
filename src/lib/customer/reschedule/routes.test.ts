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
import { POST as clientMove } from "@/app/api/customer/visits/[id]/reschedule/route";
import { POST as officeMove } from "@/app/api/admin/visits/[id]/reschedule/route";
const jobId = "95000000-0000-0000-0000-000000000001",
  id = "98000000-0000-0000-0000-000000000001";
const raw = {
  id,
  job_id: jobId,
  previous_start: "2026-10-01T15:00:00Z",
  new_start: "2026-10-03T15:00:00Z",
  new_end: "2026-10-03T16:30:00Z",
  price_cents: 20000,
  fee_cents: 0,
  released_count: 1,
  expires_at: "2026-10-01T10:05:00Z",
  confirmed_at: "2026-10-01T10:00:00Z",
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
  return (office ? officeMove : clientMove)(
    new NextRequest("https://example.test/api/move", {
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
describe("client rescheduling authorization and truthful confirmation", () => {
  it("returns the reviewed fee and its exact saved invoice", async () => {
    const fee = { ...raw, fee_cents: 6000, invoice_id: id };
    m.rpc.mockResolvedValue({ data: fee, error: null });
    const reviewed = await post({
      action: "review",
      localStart: "2026-10-03T10:00",
    });
    expect(reviewed.status).toBe(200);
    expect((await reviewed.json()).quote.feeCents).toBe(6000);
    const saved = await post({ action: "confirm", quoteId: id });
    expect(saved.status).toBe(200);
    expect((await saved.json()).receipt).toMatchObject({
      feeCents: 6000,
      invoiceId: id,
    });
  });
  it.each([
    [null, 401],
    ["admin", 403],
    ["cleaner", 403],
  ] as const)("rejects %s before private reads", async (role, code) => {
    account(role);
    expect((await post({ action: "confirm", quoteId: id })).status).toBe(code);
    expect(m.job).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("disables preview saves", async () => {
    account("customer", true);
    expect((await post({ action: "confirm", quoteId: id })).status).toBe(409);
    expect(m.client).not.toHaveBeenCalled();
  });
  it.each([null, { customerId: "other" }])(
    "rejects inaccessible visit %j",
    async (job) => {
      m.job.mockResolvedValue(job);
      expect((await post({ action: "confirm", quoteId: id })).status).toBe(404);
      expect(m.rpc).not.toHaveBeenCalled();
    },
  );
  it("requires a linked client", async () => {
    m.customer.mockResolvedValue(null);
    expect((await post({ action: "confirm", quoteId: id })).status).toBe(403);
    expect(m.job).not.toHaveBeenCalled();
  });
  it("rejects malformed visit identity", async () => {
    expect(
      (await post({ action: "confirm", quoteId: id }, false, "bad")).status,
    ).toBe(400);
    expect(m.job).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    [],
    { action: "review", localStart: "2026-03-08T02:30" },
    { action: "review", localStart: "2026-02-30T09:00" },
    { action: "review", localStart: "2026-10-03T09:00Z" },
    { action: "confirm", quoteId: "bad" },
  ])("rejects invalid review %j", async (b) => {
    expect((await post(b)).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("parses Dallas time and ignores spoofed price, ownership and release fields", async () => {
    const r = await post({
      action: "review",
      localStart: "2026-10-03T10:00",
      newStart: "wrong",
      priceCents: 1,
      customerId: "other",
      releasedCount: 0,
    });
    expect(r.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("quote_my_visit_reschedule_with_fee", {
      p_job_id: jobId,
      p_new_start: "2026-10-03T15:00:00.000Z",
    });
    expect((await r.json()).quote).toMatchObject({
      priceCents: 20000,
      feeCents: 0,
      releasedCount: 1,
    });
  });
  it("confirms exactly the reviewed quote and returns the saved receipt", async () => {
    const r = await post({
      action: "confirm",
      quoteId: id,
      localStart: "another",
      feeCents: 6000,
    });
    expect(r.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("confirm_my_visit_reschedule", {
      p_job_id: jobId,
      p_quote_id: id,
    });
    expect(await r.json()).toMatchObject({
      rescheduled: true,
      receipt: { id, jobId, feeCents: 0 },
    });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it.each([
    ["40001", 409],
    ["23514", 409],
    ["42501", 403],
    ["22023", 400],
    ["08006", 500],
  ] as const)(
    "handles database %s without leaking details",
    async (code, status) => {
      m.rpc.mockResolvedValue({
        data: null,
        error: { code, message: "PRIVATE" },
      });
      const r = await post({ action: "confirm", quoteId: id });
      expect(r.status).toBe(status);
      expect(JSON.stringify(await r.json())).not.toContain("PRIVATE");
    },
  );
  it.each([
    null,
    {},
    { ...raw, id: "bad" },
    { ...raw, job_id: "95000000-0000-0000-0000-000000000009" },
    { ...raw, new_end: raw.new_start },
    { ...raw, fee_cents: 6000 },
    { ...raw, price_cents: "20000" },
    { ...raw, released_count: -1 },
    { ...raw, confirmed_at: null },
  ])("never claims success from invalid receipt %j", async (data) => {
    m.rpc.mockResolvedValue({ data, error: null });
    expect((await post({ action: "confirm", quoteId: id })).status).toBe(500);
  });
  it("rejects a quote for a different time", async () => {
    m.rpc.mockResolvedValue({
      data: { ...raw, new_start: "2026-10-04T15:00:00Z" },
      error: null,
    });
    expect(
      (await post({ action: "review", localStart: "2026-10-03T10:00" })).status,
    ).toBe(500);
  });
  it("office requires an admin using a request-scoped session", async () => {
    expect((await post({ action: "confirm", quoteId: id }, true)).status).toBe(
      403,
    );
    account("admin");
    expect((await post({ action: "confirm", quoteId: id }, true)).status).toBe(
      200,
    );
    expect(m.customer).not.toHaveBeenCalled();
  });
});
