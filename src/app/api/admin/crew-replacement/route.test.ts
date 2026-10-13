import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ repo: vi.fn(), client: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
import { POST } from "./route";
const id = "c7600000-0000-0000-0000-000000000001",
  jobId = "c7500000-0000-0000-0000-000000000001";
const receipt = {
  id,
  jobId,
  cleanerName: "Replacement",
  type: "contractor_1099",
  payoutCents: 8000,
  hourlyRateCents: null,
  start: "2028-01-03T15:00Z",
  minutes: 90,
  clientPriceCents: 24000,
  expiresAt: "2028-01-03T14:00Z",
  state: "sent",
  assignmentId: null,
  assignmentCurrent: false,
  clientApproved: false,
  needsClientApproval: true,
  city: "Dallas",
};
const reviewCrew = [
  {
    id,
    name: "Outgoing",
    isLead: true,
    payoutCents: 8000,
    type: "contractor_1099",
  },
  {
    id: jobId,
    name: "Retained",
    isLead: false,
    payoutCents: 5100,
    type: "contractor_1099",
  },
];
function account(role: string | null, demo = false) {
  m.repo.mockResolvedValue({
    isDemo: demo,
    getCurrentProfile: async () => (role ? { id: "session-user", role } : null),
  });
}
function post(body: unknown = { action: "confirm", id }) {
  return POST(
    new NextRequest("https://example.test/api/admin/crew-replacement", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  account("admin");
  m.client.mockResolvedValue({ rpc: m.rpc });
  m.rpc.mockResolvedValue({ data: receipt, error: null });
});
describe("office crew replacement review", () => {
  it.each([
    [null, 401],
    ["cleaner", 403],
    ["customer", 403],
  ] as const)("rejects %s before loading a client", async (role, status) => {
    account(role);
    expect((await post()).status).toBe(status);
    expect(m.client).not.toHaveBeenCalled();
  });
  it("does not save a demo proposal", async () => {
    account("admin", true);
    expect((await post()).status).toBe(409);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("quotes current crew and saved pay rather than caller snapshots", async () => {
    m.rpc.mockResolvedValue({
      data: { ...receipt, state: "review", reviewCrew },
      error: null,
    });
    const r = await post({
      action: "quote",
      jobId,
      cleanerId: id,
      payoutCents: 1,
      crew: [],
    });
    expect(r.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("quote_crew_lead_replacement", {
      p_job_id: jobId,
      p_cleaner_id: id,
    });
    expect((await r.json()).reviewCrew[1].payoutCents).toBe(5100);
  });
  it("confirms only the persisted review identity", async () => {
    expect(
      (await post({ action: "confirm", id, payoutCents: 999999 })).status,
    ).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("confirm_crew_lead_replacement", {
      p_id: id,
    });
  });
  it("binds response identity to the requested action", async () => {
    m.rpc.mockResolvedValue({ data: { ...receipt, id: jobId }, error: null });
    expect((await post()).status).toBe(500);
  });
  it("refuses an incomplete review as success", async () => {
    m.rpc.mockResolvedValue({
      data: { ...receipt, state: "review", reviewCrew: [] },
      error: null,
    });
    expect((await post({ action: "quote", jobId, cleanerId: id })).status).toBe(
      500,
    );
  });
  it("withdraws a proposal without a caller assignment or pay", async () => {
    m.rpc.mockResolvedValue({
      data: { ...receipt, state: "withdrawn" },
      error: null,
    });
    expect((await post({ action: "withdraw", id })).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("withdraw_crew_lead_offer", {
      p_id: id,
    });
  });
  it("never leaks database messages on a stale review", async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: "PT409", message: "PRIVATE-CLIENT" },
    });
    const r = await post();
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).not.toContain("PRIVATE");
  });
});
