import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({
  repo: vi.fn(),
  client: vi.fn(),
  rpc: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
vi.mock("./store", () => ({ clientSchedule: m.schedule }));
import { POST as customer } from "@/app/api/customer/schedules/[id]/route";
import { POST as office } from "@/app/api/admin/schedules/[id]/route";
const plan = "d9000000-0000-0000-0000-000000000001",
  quote = "d8000000-0000-0000-0000-000000000001";
const draft = {
  firstDate: "2026-10-03",
  frequency: "weekly",
  startTime: "09:30",
  pausedUntil: "",
  endsOn: "",
};
const raw = {
  id: quote,
  expires_at: "2026-10-02T10:05:00Z",
  confirmed_at: "2026-10-02T10:01:00Z",
  review: {
    plan_id: plan,
    effective_from: "2026-10-03",
    first_date: "2026-10-03",
    freq: "weekly",
    start_time: "09:30:00",
    paused_until: null,
    ends_on: null,
    price_cents: 20000,
    previous_price_cents: 20000,
    estimated_minutes: 90,
    fee_cents: 0,
    horizon_until: "2026-11-14",
    visits: [],
    preserved_skips: [],
  },
};
function account(role: string | null, demo = false) {
  m.repo.mockResolvedValue({
    isDemo: demo,
    getCurrentProfile: async () => (role ? { id: "profile", role } : null),
    getCustomerByProfile: async () => ({ id: "own" }),
  });
}
function post(body: unknown, admin = false, id = plan) {
  return (admin ? office : customer)(
    new NextRequest("https://example.test/api/series", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  account("customer");
  m.client.mockResolvedValue({ rpc: m.rpc });
  m.schedule.mockResolvedValue({ id: plan, customerId: "own" });
  m.rpc.mockResolvedValue({ data: raw, error: null });
});
describe("recurring editor authorization and receipts", () => {
  it.each([
    [null, 401],
    ["cleaner", 403],
    ["admin", 403],
  ] as const)("rejects %s before private reads", async (role, status) => {
    account(role);
    expect((await post({ action: "confirm", quoteId: quote })).status).toBe(
      status,
    );
    expect(m.client).not.toHaveBeenCalled();
  });
  it("disables demo saves", async () => {
    account("customer", true);
    expect((await post({ action: "review", draft })).status).toBe(409);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it.each([null, { customerId: "other" }])(
    "rejects unavailable plan %j",
    async (value) => {
      m.schedule.mockResolvedValue(value);
      expect((await post({ action: "review", draft })).status).toBe(404);
      expect(m.rpc).not.toHaveBeenCalled();
    },
  );
  it("reviews only editable schedule choices and ignores injected prices and ownership", async () => {
    const r = await post({
      action: "review",
      draft: { ...draft, priceCents: 1, customerId: "other" },
      feeCents: 6000,
    });
    expect(r.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("quote_my_recurring_schedule", {
      p_plan: plan,
      p_first: "2026-10-03",
      p_freq: "weekly",
      p_time: "09:30",
      p_pause: null,
      p_end: null,
    });
    expect((await r.json()).quote.review.price_cents).toBe(20000);
  });
  it("only confirms the actor-bound quote ID", async () => {
    const r = await post({
      action: "confirm",
      quoteId: quote,
      draft: { ...draft, firstDate: "2026-10-20" },
    });
    expect(r.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("confirm_my_recurring_schedule", {
      p_plan: plan,
      p_quote: quote,
    });
    expect((await r.json()).saved).toBe(true);
  });
  it("provides the same office review after role validation", async () => {
    account("admin");
    expect((await post({ action: "review", draft }, true)).status).toBe(200);
  });
  it.each([
    {},
    null,
    { action: "confirm", quoteId: "bad" },
    { action: "review", draft: { ...draft, firstDate: "2026-02-30" } },
  ])("rejects invalid action %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["40001", 409],
    ["42501", 403],
    ["22023", 400],
    ["08006", 500],
  ] as const)("maps %s without falsely confirming", async (code, status) => {
    m.rpc.mockResolvedValue({ data: null, error: { code } });
    const r = await post({ action: "confirm", quoteId: quote });
    expect(r.status).toBe(status);
    expect(await r.json()).not.toHaveProperty("saved");
  });
  it("rejects a mismatched saved identity", async () => {
    m.rpc.mockResolvedValue({ data: { ...raw, id: plan }, error: null });
    expect((await post({ action: "confirm", quoteId: quote })).status).toBe(
      500,
    );
  });
});
