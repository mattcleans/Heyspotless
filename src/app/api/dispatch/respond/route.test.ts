import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({
  repo: vi.fn(),
  rpc: vi.fn(),
  admin: vi.fn(),
  cleaner: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
import { POST } from "./route";
const offer = "f6000000-0000-0000-0000-000000000001";
function account(role: string | null, demo = false) {
  m.repo.mockResolvedValue({
    isDemo: demo,
    getCurrentProfile: async () => (role ? { id: "own-profile", role } : null),
    getCleanerByProfile: m.cleaner,
  });
}
function post(body: unknown = { offerId: offer, accept: true }) {
  return POST(
    new NextRequest("https://example.test/api/dispatch/respond", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  account("cleaner");
  m.cleaner.mockResolvedValue({ id: "own-cleaner" });
  m.admin.mockReturnValue({ rpc: m.rpc });
  m.rpc.mockResolvedValue({ data: "accepted", error: null });
});
describe("cleaner capacity offer answers", () => {
  it.each([
    [null, 401],
    ["customer", 403],
    ["admin", 403],
  ] as const)("rejects %s before server write", async (role, status) => {
    account(role);
    expect((await post()).status).toBe(status);
    expect(m.admin).not.toHaveBeenCalled();
  });
  it("refuses preview writes before loading a privileged client", async () => {
    account("cleaner", true);
    const r = await post();
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ preview: true });
    expect(m.admin).not.toHaveBeenCalled();
  });
  it("requires a linked cleaner", async () => {
    m.cleaner.mockResolvedValue(null);
    expect((await post()).status).toBe(403);
    expect(m.admin).not.toHaveBeenCalled();
  });
  it("uses session identity and accepted offer pay rather than caller cleaner/pay fields", async () => {
    const r = await post({
      offerId: offer,
      accept: true,
      cleanerId: "other",
      payoutCents: 999999,
    });
    expect(r.status).toBe(200);
    expect(m.cleaner).toHaveBeenCalledWith("own-profile");
    expect(m.rpc).toHaveBeenCalledWith("respond_to_offer_with_capacity", {
      p_offer_id: offer,
      p_cleaner_id: "own-cleaner",
      p_accept: true,
      p_reason: null,
    });
  });
  it("settles the lost-capacity result without marking a decline", async () => {
    m.rpc.mockResolvedValue({ data: "conflict", error: null });
    const r = await post();
    expect(r.status).toBe(409);
    const d = await r.json();
    expect(d.outcome).toBe("conflict");
    expect(d.message).toContain("withdrawn");
    expect(d.message).toContain("count against you");
    expect(d.retryable).toBeUndefined();
  });
  it.each(["40001", "40P01"])(
    "keeps genuine %s retryable without a false saved outcome or private details",
    async (code) => {
      m.rpc.mockResolvedValue({
        data: null,
        error: { code, message: "PRIVATE CLIENT/ACCESS DETAILS" },
      });
      const r = await post();
      const d = await r.json();
      expect(r.status).toBe(409);
      expect(d.retryable).toBe(true);
      expect(d.outcome).toBeUndefined();
      expect(JSON.stringify(d)).not.toContain("PRIVATE");
    },
  );
  it("does not disclose another cleaner's offer", async () => {
    m.rpc.mockResolvedValue({ data: "not_found", error: null });
    expect((await post()).status).toBe(404);
  });
  it("fails safely before the capacity migration is installed", async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "PRIVATE schema details" },
    });
    const r = await post();
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("PRIVATE");
  });
  it.each([{}, null, { offerId: offer, accept: "true" }])(
    "refuses invalid input %j before authentication/database work",
    async (body) => {
      expect((await post(body)).status).toBe(400);
      expect(m.repo).not.toHaveBeenCalled();
    },
  );
});
