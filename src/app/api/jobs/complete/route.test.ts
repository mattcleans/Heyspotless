import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({ profile: vi.fn(), cleaner: vi.fn(), complete: vi.fn(), photos: vi.fn(), home: vi.fn(), job: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ({ getCurrentProfile: m.profile, getCleanerByProfile: m.cleaner, getJob: m.job, getProperty: m.home }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/service/store", () => ({ BackupApprovalRequired: class extends Error {}, ServiceStore: class { complete = m.complete; photosFor = m.photos; } }));
import { POST } from "./route";

const request = () => new NextRequest("https://example.test/api/jobs/complete", { method: "POST", body: JSON.stringify({ jobId: "job" }) });
beforeEach(() => {
  vi.resetAllMocks();
  m.profile.mockResolvedValue({ id: "profile", role: "cleaner" });
  m.cleaner.mockResolvedValue({ id: "cleaner" });
  m.complete.mockResolvedValue(true);
  m.job.mockResolvedValue({ id: "job", status: "complete", propertyId: "home", bedrooms: 0, bathrooms: 0 });
  m.home.mockResolvedValue({ rooms: { bedrooms: 0, bathrooms: 0, halfBaths: 1, kitchens: 2, livingRooms: 2, utilityRooms: 2 } });
  m.photos.mockResolvedValue(["kitchen_1", "living_room_1", "utility_room_1"].flatMap(roomKey => ["before", "after"].map(kind => ({ roomKey, kind }))));
});

describe("completion photo requirements", () => {
  it("finishes the clean while reporting every configured room still missing photos", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ completed: true, billable: false, outstanding: expect.arrayContaining(["half_bath_1", "kitchen_2", "living_room_2", "utility_room_2"].map(room => expect.objectContaining({ room }))) });
  });
  it("does not claim billing readiness if the home cannot be read", async () => {
    m.home.mockResolvedValue(null);
    expect(await (await POST(request())).json()).toMatchObject({ completed: true, billable: false });
  });
  it("does not perform readiness reads for an unconfirmed completion", async () => {
    m.complete.mockResolvedValue(false);
    expect((await POST(request())).status).toBe(409);
    expect(m.home).not.toHaveBeenCalled();
  });
});
