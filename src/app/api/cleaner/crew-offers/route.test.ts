import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ repo: vi.fn(), client: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
import { POST } from "./route";
const id = "c7600000-0000-0000-0000-000000000001";
const saved = {
  id,
  jobId: "c7500000-0000-0000-0000-000000000001",
  cleanerName: "Replacement",
  type: "contractor_1099",
  payoutCents: 8000,
  hourlyRateCents: null,
  start: "2028-01-03T15:00Z",
  minutes: 90,
  clientPriceCents: 24000,
  expiresAt: "2028-01-03T14:00Z",
  state: "accepted",
  assignmentId: id,
  assignmentCurrent: true,
  clientApproved: false,
  needsClientApproval: true,
  city: "Dallas",
};
function account(role: string | null, demo = false) {
  m.repo.mockResolvedValue({
    isDemo: demo,
    getCurrentProfile: async () => (role ? { id: "session-user", role } : null),
  });
}
function post(body: unknown = { id, accept: true }) {
  return POST(
    new NextRequest("https://example.test/api/cleaner/crew-offers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  account("cleaner");
  m.client.mockResolvedValue({ rpc: m.rpc });
  m.rpc.mockResolvedValue({ data: saved, error: null });
});
describe("own contractor replacement answer", () => {
  it("returns only own terms even when an older RPC includes office fields", async () => {
    m.rpc.mockResolvedValue({
      data: {
        ...saved,
        reviewCrew: [{ payoutCents: 5100 }],
        accessNotes: "PRIVATE",
      },
      error: null,
    });
    const response = await post();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.payoutCents).toBe(8000);
    expect(body).not.toHaveProperty("clientPriceCents");
    expect(body).not.toHaveProperty("reviewCrew");
    expect(body).not.toHaveProperty("accessNotes");
  });
  it("accepts the narrowed RPC receipt without a client price", async () => {
    const { clientPriceCents: omitted, ...own } = saved;
    expect(omitted).toBe(24000);
    m.rpc.mockResolvedValue({ data: own, error: null });
    const response = await post();
    expect(response.status).toBe(200);
    expect((await response.json()).payoutCents).toBe(8000);
  });
  it.each([
    [null, 401],
    ["admin", 403],
    ["customer", 403],
  ] as const)("rejects %s before a write", async (role, status) => {
    account(role);
    expect((await post()).status).toBe(status);
    expect(m.client).not.toHaveBeenCalled();
  });
  it("refuses demo saves", async () => {
    account("cleaner", true);
    expect((await post()).status).toBe(409);
    expect(m.client).not.toHaveBeenCalled();
  });
  it("uses only the actor-scoped RPC and saved exact offer pay", async () => {
    expect(
      (
        await post({
          id,
          accept: true,
          payoutCents: 999999,
          cleanerId: "other",
        })
      ).status,
    ).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("respond_my_crew_lead_offer", {
      p_id: id,
      p_accept: true,
    });
  });
  it("does not show a decline as saved acceptance", async () => {
    m.rpc.mockResolvedValue({
      data: {
        ...saved,
        state: "declined",
        assignmentId: null,
        assignmentCurrent: false,
      },
      error: null,
    });
    expect((await post()).status).toBe(500);
  });
  it.each(["40001", "40P01", "PT409", "23514"])(
    "keeps %s recoverable without private database messages",
    async (code) => {
      m.rpc.mockResolvedValue({
        data: null,
        error: { code, message: "PRIVATE-GATE" },
      });
      const r = await post();
      expect(r.status).toBe(409);
      expect(JSON.stringify(await r.json())).not.toContain("PRIVATE");
    },
  );
  it("not-found ownership is denied safely", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    expect((await post()).status).toBe(403);
  });
  it("withdrawn offers return their durable outcome", async () => {
    m.rpc.mockResolvedValue({
      data: {
        ...saved,
        state: "withdrawn",
        assignmentId: null,
        assignmentCurrent: false,
      },
      error: null,
    });
    const r = await post();
    expect(r.status).toBe(200);
    expect((await r.json()).state).toBe("withdrawn");
  });
  it("rejects malformed answers before RPC", async () => {
    expect((await post({ id, accept: "true" })).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
