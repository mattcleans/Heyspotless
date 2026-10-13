import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ repo: vi.fn(), client: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
import { POST } from "./route";
const id = "c8400000-0000-0000-0000-000000000001";
const q = {
  id,
  customerId: id,
  propertyId: id,
  service: "standard",
  frequency: "one_time",
  totalCents: 5000,
  estimatedMinutes: 30,
  proposedStart: "2028-01-03T15:00:00Z",
  expiresAt: "2027-12-30T15:00:00Z",
  repeats: false,
  note: "",
  version: 1,
  accepted: null,
  decisionId: null,
  jobId: null,
  planId: null,
  state: "published",
  home: { street: "Sample", city: "Dallas", state: "TX", zip: "75001" },
  lines: [
    {
      itemKey: "arrival",
      name: "Arrival",
      quantity: 1,
      unitPriceCents: 5000,
      totalCents: 5000,
      cleanMinutes: 30,
      isExtra: false,
    },
  ],
};
function account(role: string | null, demo = false) {
  m.repo.mockResolvedValue({
    isDemo: demo,
    getCurrentProfile: async () => (role ? { id: "actor", role } : null),
  });
}
function post(body: unknown = { action: "publish", id }) {
  return POST(
    new NextRequest("https://example.test/api/quotes", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  account("admin");
  m.client.mockResolvedValue({ rpc: m.rpc });
  m.rpc.mockResolvedValue({ data: q, error: null });
});
describe("client quote API boundary", () => {
  it.each([
    [null, 401],
    ["cleaner", 403],
    ["customer", 403],
  ] as const)("rejects %s before an office mutation", async (role, status) => {
    account(role);
    expect((await post()).status).toBe(status);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("refuses demo mutation", async () => {
    account("admin", true);
    expect((await post()).status).toBe(409);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("requires the customer to decide their owned quote", async () => {
    account("customer");
    m.rpc.mockResolvedValue({
      data: { ...q, state: "accepted", accepted: true, decisionId: id },
      error: null,
    });
    expect(
      (
        await post({
          action: "decide",
          id,
          version: 1,
          requestId: id,
          accept: true,
        })
      ).status,
    ).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("decide_client_quote", {
      p_id: id,
      p_version: 1,
      p_request: id,
      p_accept: true,
    });
  });
  it("does not let the office impersonate approval", async () => {
    expect(
      (
        await post({
          action: "decide",
          id,
          version: 1,
          requestId: id,
          accept: true,
        })
      ).status,
    ).toBe(403);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("books only the saved version without caller price or date", async () => {
    m.rpc.mockResolvedValue({
      data: {
        ...q,
        state: "booked",
        accepted: true,
        decisionId: id,
        jobId: id,
      },
      error: null,
    });
    expect((await post({ action: "book", id, version: 2 })).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("book_client_quote", {
      p_id: id,
      p_version: 2,
    });
    expect(
      (await post({ action: "book", id, version: 2, totalCents: 1 })).status,
    ).toBe(400);
  });
  it("refuses another quote identity in a success response", async () => {
    m.rpc.mockResolvedValue({
      data: { ...q, id: "c8400000-0000-0000-0000-000000000002" },
      error: null,
    });
    expect((await post()).status).toBe(503);
  });
  it("requires a booked receipt for booking success", async () => {
    expect((await post({ action: "book", id, version: 2 })).status).toBe(503);
  });
  it("refuses incomplete success payloads", async () => {
    m.rpc.mockResolvedValue({ data: { id }, error: null });
    expect((await post()).status).toBe(503);
  });
  it.each(["40001", "40P01", "23505", "PGRST202"])(
    "keeps %s retryable without inventing a save",
    async (code) => {
      m.rpc.mockResolvedValue({ data: null, error: { code } });
      const r = await post();
      expect(r.status).toBe(503);
      expect((await r.json()).retryable).toBe(true);
    },
  );
  it("requires fresh review for a business conflict", async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: "PT409", message: "private details" },
    });
    const r = await post();
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).not.toContain("private");
  });
  it("binds prepared dates to Dallas time and ignores no economic fields", async () => {
    expect(
      (
        await post({
          action: "prepare",
          id,
          propertyId: id,
          service: "standard",
          frequency: "one_time",
          start: "2028-01-03T09:00",
          expires: "2028-01-02T09:00",
          repeats: false,
          extras: [],
          note: "",
        })
      ).status,
    ).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith(
      "prepare_client_quote",
      expect.objectContaining({
        p_start: "2028-01-03T15:00:00.000Z",
        p_expires: "2028-01-02T15:00:00.000Z",
      }),
    );
  });
});
