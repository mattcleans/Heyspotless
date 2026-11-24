import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({ profile: vi.fn(), admin: vi.fn(), rpc: vi.fn(), demo: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ({ getCurrentProfile: m.profile }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: m.demo }));

import { POST } from "./route";

const customer = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const signIn = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ctx = (id = customer) => ({ params: Promise.resolve({ id }) });
const request = (body: unknown = { profileId: signIn, confirmedIdentity: true }, headers: Record<string, string> = {}) =>
  new NextRequest(`https://example.test/api/admin/customers/${customer}/sign-in`, { method: "POST", body: JSON.stringify(body), headers });

beforeEach(() => {
  vi.resetAllMocks();
  m.profile.mockResolvedValue({ id: "staff", role: "admin" });
  m.demo.mockReturnValue(false);
  m.admin.mockReturnValue({ rpc: m.rpc });
  m.rpc.mockResolvedValue({ data: { connected: true, alreadyConnected: false }, error: null });
});

describe("connecting a customer's sign-in", () => {
  it.each([[null, 401], [{ id: "c", role: "customer" }, 403], [{ id: "k", role: "cleaner" }, 403]])(
    "refuses %j before any privileged work",
    async (profile, status) => {
      m.profile.mockResolvedValue(profile);
      expect((await POST(request(), ctx())).status).toBe(status);
      expect(m.admin).not.toHaveBeenCalled();
    },
  );

  it("is unavailable in demo mode", async () => {
    m.demo.mockReturnValue(true);
    expect((await POST(request(), ctx())).status).toBe(503);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await POST(request(undefined, { origin: "https://elsewhere.test" }), ctx())).status).toBe(403);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["a bad customer id", { profileId: signIn, confirmedIdentity: true }, "not-a-uuid"],
    ["no sign-in", { confirmedIdentity: true }, customer],
    ["a bad sign-in id", { profileId: "x", confirmedIdentity: true }, customer],
    ["no confirmation", { profileId: signIn }, customer],
    ["a non-boolean confirmation", { profileId: signIn, confirmedIdentity: "yes" }, customer],
  ])("refuses %s", async (_label, body, id) => {
    expect((await POST(request(body), ctx(id))).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("connects as the signed-in Management profile", async () => {
    const response = await POST(request(), ctx());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: true, alreadyConnected: false });
    expect(m.rpc).toHaveBeenCalledWith("connect_customer_sign_in", { p_customer: customer, p_profile: signIn, p_actor: "staff" });
  });

  it("says when the sign-in was already connected", async () => {
    m.rpc.mockResolvedValue({ data: { connected: true, alreadyConnected: true }, error: null });
    const response = await POST(request(), ctx());
    expect(await response.json()).toMatchObject({ alreadyConnected: true, message: expect.stringContaining("already connected") });
  });

  it.each([
    ["email_mismatch", "update their contact details"],
    ["email_not_confirmed", "confirmed its email"],
    ["sign_in_in_use", "another customer"],
    ["customer_has_sign_in", "already connected"],
    ["something_new", "could not be made"],
  ])("explains the database's refusal (%s)", async (reason, text) => {
    m.rpc.mockResolvedValue({ data: { connected: false, reason }, error: null });
    const response = await POST(request(), ctx());
    expect(response.status).toBe(409);
    expect((await response.json()).message).toContain(text);
  });

  it("does not leak database errors", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: "private diagnostic" } });
    const response = await POST(request(), ctx());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private diagnostic");
  });
});
