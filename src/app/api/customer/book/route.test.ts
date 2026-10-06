import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ repo: vi.fn(), client: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
import { POST } from "./route";
import { bookingFixture } from "@/lib/booking/test-fixtures";
const id = bookingFixture.id;
function account(role: string | null, isDemo = false) { m.repo.mockResolvedValue({ isDemo, getCurrentProfile: async () => role ? { id, role } : null }); }
function post(body: unknown = { action: "confirm", id }) { return POST(new NextRequest("https://example.test/api/customer/book", { method: "POST", body: JSON.stringify(body) })); }
beforeEach(() => { vi.clearAllMocks(); account("customer"); m.client.mockResolvedValue({ rpc: m.rpc }); m.rpc.mockResolvedValue({ data: { ...bookingFixture, state: "requested", jobId: id }, error: null }); });
describe("Client booking endpoint", () => {
  it.each([[null, 401], ["admin", 403], ["cleaner", 403]])("denies %s before database access", async (role, status) => {
    account(role as string | null); expect((await post()).status).toBe(status); expect(m.client).not.toHaveBeenCalled();
  });
  it("does not write demo choices", async () => { account("customer", true); expect((await post()).status).toBe(409); expect(m.rpc).not.toHaveBeenCalled(); });
  it("confirms only the immutable review identity", async () => { expect((await post()).status).toBe(200); expect(m.rpc).toHaveBeenCalledWith("confirm_my_booking", { p_id: id }); });
  it("reviews saved-home choices without accepting client totals or contact fields", async () => {
    m.rpc.mockResolvedValue({ data: bookingFixture, error: null });
    expect((await post({ action: "review", id, propertyId: id, service: "standard", frequency: "biweekly", repeats: false,
      start: "2028-01-07T11:00", extras: [], note: "Saved choices" })).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("review_my_booking", { p_id: id, p_property_id: id, p_service: "standard", p_freq: "biweekly",
      p_start: "2028-01-07T17:00:00.000Z", p_repeats: false, p_extras: [], p_note: "Saved choices" });
  });
  it("refuses a returned review that changes the requested appointment", async () => {
    m.rpc.mockResolvedValue({ data: { ...bookingFixture, requestedStart: "2028-01-08T17:00:00Z" }, error: null });
    expect((await post({ action: "review", id, propertyId: id, service: "standard", frequency: "biweekly", repeats: false,
      start: "2028-01-07T11:00", extras: [], note: "Saved choices" })).status).toBe(503);
  });
  it("does not forward price, ownership or assignment overrides", async () => { expect((await post({ action: "confirm", id, customerId: id, totalCents: 1 })).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled(); });
  it.each(["PT409", "PBO01", "42501", "23514"])("preserves database refusal %s", async code => {
    m.rpc.mockResolvedValue({ data: { ...bookingFixture, state: "requested", jobId: id }, error: { code } });
    expect((await post()).status).toBe(code === "42501" ? 403 : code === "23514" ? 400 : 409);
  });
  it.each([null, bookingFixture, { ...bookingFixture, state: "requested", jobId: id, id: "c9100000-0000-0000-0000-000000000002" }])(
    "does not claim success from an invalid or mismatched receipt", async data => { m.rpc.mockResolvedValue({ data, error: null }); expect((await post()).status).toBe(503); },
  );
  it("returns a recoverable failure when the database response is lost", async () => { m.rpc.mockRejectedValue(new Error("synthetic timeout")); expect((await post()).status).toBe(503); });
});
