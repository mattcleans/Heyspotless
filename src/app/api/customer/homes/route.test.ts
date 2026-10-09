import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ repo: vi.fn(), client: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
import { POST } from "./route";
const input = { id: "d9100000-0000-4000-8000-000000000001", home: { street: "100 Test Way", city: "Dallas", state: "TX", zip: "75201", bedrooms: 2, bathrooms: 2, halfBaths: 0, kitchens: 1, livingRooms: 1, utilityRooms: 1 }, contact: null };
function account(role: string | null, demo = false) { m.repo.mockResolvedValue({ isDemo: demo, getCurrentProfile: async () => role ? { id: "self", role } : null }); }
const post = (body: unknown = input, origin = "https://app.example.test") => POST(new NextRequest("https://app.example.test/api/customer/homes", { method: "POST", headers: { origin }, body: JSON.stringify(body) }));
beforeEach(() => { vi.clearAllMocks(); account("customer"); m.client.mockResolvedValue({ rpc: m.rpc }); m.rpc.mockResolvedValue({ error: null, data: { id: input.id, customerId: "d9200000-0000-4000-8000-000000000001", home: input.home } }); });
describe("own Client home save", () => {
  it.each([[null, 401], ["cleaner", 403], ["admin", 403]])("denies %s before the write client", async (role, status) => { account(role as string | null); expect((await post()).status).toBe(status); expect(m.client).not.toHaveBeenCalled(); });
  it("denies a cross-origin request before reading the account", async () => { expect((await post(input, "https://other.example.test")).status).toBe(403); expect(m.repo).not.toHaveBeenCalled(); });
  it("never saves sample data", async () => { account("customer", true); expect((await post()).status).toBe(409); expect(m.rpc).not.toHaveBeenCalled(); });
  it("never accepts a caller-supplied customer or property id", async () => { expect((await post({ ...input, customerId: "other" })).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled(); });
  it("forwards the exact reviewed identity and returns a validated home", async () => { expect((await post()).status).toBe(200); expect(m.rpc).toHaveBeenCalledWith("save_my_home", { p_id: input.id, p_home: input.home, p_contact: null }); });
  it.each([["42501",403],["PHC01",409],["PT409",409],["22023",400],["XX000",503]])("returns safe recovery for %s", async (code, status) => { m.rpc.mockResolvedValue({ error: { code, message: "private backend detail" } }); const r = await post(); expect(r.status).toBe(status); expect(JSON.stringify(await r.json())).not.toContain("private backend detail"); });
  it("does not claim success for a mismatched saved home", async () => { m.rpc.mockResolvedValue({ error: null, data: { id: input.id, customerId: input.id, home: { ...input.home, zip: "75024" } } }); expect((await post()).status).toBe(503); });
});
