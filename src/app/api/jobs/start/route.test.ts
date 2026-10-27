import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ profile: vi.fn(), start: vi.fn(), job: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ({ getCurrentProfile: m.profile, getCleanerByProfile: async () => ({ id: "cleaner" }), getJob: m.job }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/service/store", () => ({ BackupApprovalRequired: class extends Error {}, ServiceStore: class { start = m.start; } }));
import { POST } from "./route";
const request = () => new NextRequest("https://example.test/api/jobs/start", { method: "POST", body: JSON.stringify({ jobId: "job" }) });
beforeEach(() => { vi.resetAllMocks();m.profile.mockResolvedValue({ id: "self", role: "cleaner" });m.start.mockResolvedValue(true);m.job.mockResolvedValue({ id: "job", customerId: "client", propertyId: "home", bedrooms: 8, bathrooms: 8, roomScope: { jobId: "job", customerId: "client", propertyId: "home", rooms: { bedrooms: 1, bathrooms: 1, halfBaths: 1, kitchens: 2, livingRooms: 0, utilityRooms: 0 }, source: "client_booking", capturedAt: new Date() } }); });
describe("start uses the saved visit checklist", () => {
  it("returns the frozen full room list despite changed home summaries", async () => { const data = await (await POST(request())).json();expect(data).toMatchObject({ started: true, requirementsAvailable: true });expect(data.rooms.map((r: { key: string }) => r.key)).toEqual(["kitchen_1", "kitchen_2", "bathroom_1", "half_bath_1", "bedroom_1"]); });
  it("does not invent a zero-room agreement when scope is unavailable", async () => { m.job.mockResolvedValue({ id: "job", customerId: "client", propertyId: "home", roomScope: null });expect(await (await POST(request())).json()).toMatchObject({ started: true, requirementsAvailable: false, rooms: [] }); });
});
