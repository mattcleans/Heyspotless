import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  repo: vi.fn(),
  client: vi.fn(),
  rpc: vi.fn(),
  property: vi.fn(),
  customer: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: mocks.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
import { POST } from "./route";
const id = "95000000-0000-0000-0000-000000000001";
const empty = {
  gateCode: null,
  accessNotes: null,
  parkingNotes: null,
  pets: null,
};
const body = {
  instructions: { ...empty, accessNotes: " Side door " },
  expected: empty,
  customerId: "other",
};
const request = (payload: unknown = body) =>
  new NextRequest(
    "https://app.example.test/api/customer/homes/own/instructions",
    { method: "POST", body: JSON.stringify(payload) },
  );
const save = (payload: unknown = body, homeId = id) =>
  POST(request(payload), { params: Promise.resolve({ id: homeId }) });
function account(role: string | null, demo = false) {
  mocks.repo.mockResolvedValue({
    isDemo: demo,
    getCurrentProfile: async () => (role ? { id: "self", role } : null),
    getCustomerByProfile: mocks.customer,
    getProperty: mocks.property,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  account("customer");
  mocks.customer.mockResolvedValue({ id: "my-customer" });
  mocks.property.mockResolvedValue({ id, customerId: "my-customer", ...empty });
  mocks.client.mockResolvedValue({ rpc: mocks.rpc });
  mocks.rpc.mockResolvedValue({
    data: { ...empty, accessNotes: "Side door" },
    error: null,
  });
});
describe("own home instruction save", () => {
  it.each([
    [null, 401],
    ["admin", 403],
    ["cleaner", 403],
  ])("rejects %s before a write", async (role, status) => {
    account(role as string | null);
    expect((await save()).status).toBe(status);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.property).not.toHaveBeenCalled();
  });
  it("rejects an unlinked customer without requesting a property", async () => {
    mocks.customer.mockResolvedValue(null);
    expect((await save()).status).toBe(403);
    expect(mocks.property).not.toHaveBeenCalled();
  });
  it("rejects malformed home identifiers before a property read", async () => {
    expect((await save(body, "not-an-id")).status).toBe(400);
    expect(mocks.property).not.toHaveBeenCalled();
  });
  it.each([null, { id, customerId: "other-customer", ...empty }])(
    "rejects an inaccessible or other-owned home %j",
    async (property) => {
      mocks.property.mockResolvedValue(property);
      expect((await save()).status).toBe(404);
      expect(mocks.client).not.toHaveBeenCalled();
    },
  );
  it("refuses demo writes", async () => {
    account("customer", true);
    expect((await save()).status).toBe(409);
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("passes only instruction values and original state, never caller ownership or address changes", async () => {
    const response = await save({
      ...body,
      instructions: {
        ...body.instructions,
        customerId: "other",
        bedrooms: 99,
        street: "Forged",
      },
    });
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("set_my_home_instructions", {
      p_property_id: id,
      p_gate_code: null,
      p_access_notes: "Side door",
      p_parking_notes: null,
      p_pets: null,
      p_expected: empty,
    });
  });
  it.each([
    null,
    {},
    { instructions: empty },
    { ...body, instructions: { ...empty, pets: "x".repeat(1001) } },
  ])(
    "rejects malformed or incomplete payload %j before a write",
    async (payload) => {
      expect((await save(payload)).status).toBe(400);
      expect(mocks.client).not.toHaveBeenCalled();
    },
  );
  it.each(["PT409", "40001", "40P01"])(
    "returns the latest own instructions for conflict %s without reporting a save",
    async (code) => {
      mocks.rpc.mockResolvedValue({
        data: null,
        error: { code, message: "PRIVATE DATABASE DETAILS" },
      });
      mocks.property
        .mockResolvedValueOnce({ id, customerId: "my-customer", ...empty })
        .mockResolvedValueOnce({
          id,
          customerId: "my-customer",
          ...empty,
          pets: "Cat",
        });
      const response = await save(),
        data = await response.json();
      expect(response.status).toBe(409);
      expect(data.latest.pets).toBe("Cat");
      expect(data.saved).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain("PRIVATE DATABASE DETAILS");
    },
  );
  it.each(["PT409", "40001", "40P01"])(
    "never includes another owner's latest instructions after conflict %s",
    async (code) => {
      mocks.rpc.mockResolvedValue({
        data: null,
        error: { code, message: "PRIVATE DATABASE DETAILS" },
      });
      mocks.property
        .mockResolvedValueOnce({ id, customerId: "my-customer", ...empty })
        .mockResolvedValueOnce({
          id,
          customerId: "other-customer",
          ...empty,
          gateCode: "secret",
        });
      const data = await (await save()).json();
      expect(data.latest).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain("secret");
    },
  );
  it.each(["42501", "08006"])(
    "does not claim success on database error %s",
    async (code) => {
      mocks.rpc.mockResolvedValue({ data: null, error: { code } });
      const response = await save();
      expect(response.status).toBe(code === "42501" ? 403 : 500);
      expect(await response.json()).not.toHaveProperty("saved", true);
    },
  );
  it("requires authoritative saved values, not just an error-free database response", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect((await save()).status).toBe(500);
  });
});
