import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ repo: vi.fn(), client: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: mocks.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
import { POST } from "./route";

const windows = [{ day: 1, startsAt: "09:00", endsAt: "15:00" }];
const request = (body: unknown = { windows, cleanerId: "someone-else" }) => new NextRequest("https://app.example.test/api/cleaner/availability", { method: "POST", body: JSON.stringify(body) });
function account(role: string | null, active = true, demo = false) {
  mocks.repo.mockResolvedValue({ isDemo: demo, getCurrentProfile: async () => role ? { id: "self", role } : null, getCleanerByProfile: async () => ({ id: "mine", status: active ? "active" : "applicant" }) });
}
beforeEach(() => {
  vi.clearAllMocks();
  account("cleaner");
  mocks.client.mockResolvedValue({ rpc: mocks.rpc });
  mocks.rpc.mockResolvedValue({ error: null });
});
describe("availability save authorization", () => {
  it.each([[null, 401], ["customer", 403], ["admin", 403]])("rejects role %s before reaching the write client", async (role, status) => {
    account(role as string | null);
    expect((await POST(request())).status).toBe(status);
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("requires an active cleaner and refuses demo mutations", async () => {
    account("cleaner", false);
    expect((await POST(request())).status).toBe(403);
    account("cleaner", true, true);
    expect((await POST(request())).status).toBe(409);
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("does not forward a forged cleaner identity to the database", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("set_my_availability", { p_windows: windows });
  });
  it("rejects overlaps before a database write", async () => {
    expect((await POST(request({ windows: [...windows, ...windows] }))).status).toBe(400);
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("does not report success when the atomic database save fails", async () => {
    mocks.rpc.mockResolvedValue({ error: { message: "write failed" } });
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("saved", true);
  });
});
