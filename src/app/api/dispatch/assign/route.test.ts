import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  repo: {
    isDemo: false,
    getCurrentProfile: vi.fn(),
    getJob: vi.fn(),
    getCleaner: vi.fn(),
    listJobs: vi.fn(),
  },
  rpc: vi.fn(),
  assignDemoJob: vi.fn(),
  offerDemoJob: vi.fn(),
  recipientsFor: vi.fn(),
  wakeCleaner: vi.fn(),
  textOffer: vi.fn(),
  messagingOn: vi.fn(),
  sendWindowFor: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: async () => h.repo }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/demo/added", () => ({
  assignDemoJob: h.assignDemoJob,
  offerDemoJob: h.offerDemoJob,
}));
vi.mock("@/lib/messaging/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/store")>()),
  MessagingStore: class {
    recipientsFor = h.recipientsFor;
  },
}));
vi.mock("@/lib/push/store", () => ({ PushStore: class {} }));
vi.mock("@/lib/push/vapid", () => ({ isPushEnabled: () => false }));
vi.mock("@/lib/messaging/env", () => ({ isMessagingEnabled: h.messagingOn }));
vi.mock("@/lib/messaging/quiet-hours", () => ({ sendWindowFor: h.sendWindowFor }));
vi.mock("@/lib/dispatch/notify", () => ({
  wakeCleaner: h.wakeCleaner,
  textOffer: h.textOffer,
}));
import { POST } from "./route";

const JOB = {
  id: "job-1",
  priceCents: 30000,
  estimatedCleanMinutes: 180,
  zip: "75024",
  customerName: "A Customer",
  street: "1 Main St",
  city: "Plano",
  scheduledStart: new Date(Date.now() + 5 * 24 * 3_600_000),
};
const EMPLOYEE = { id: "shonda", name: "Shonda", type: "w2_core" };
const CONTRACTOR = { id: "c-dee", name: "Dee", type: "contractor_1099" };

const request = (body: unknown) =>
  new NextRequest("https://app.example.test/api/dispatch/assign", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.repo.isDemo = false;
  h.repo.getCurrentProfile.mockResolvedValue({ id: "admin-1", role: "admin" });
  h.repo.getJob.mockResolvedValue(JOB);
  h.repo.listJobs.mockResolvedValue([JOB]);
  h.repo.getCleaner.mockImplementation(async (id: string) =>
    [EMPLOYEE, CONTRACTOR].find((c) => c.id === id) ?? null,
  );
  h.rpc.mockImplementation(async (fn: string) =>
    fn === "assign_job_manually"
      ? { data: "assigned", error: null }
      : { data: [{ outcome: "offered", offer_id: "offer-1" }], error: null },
  );
  h.messagingOn.mockReturnValue(true);
  h.sendWindowFor.mockReturnValue({ send: true, reason: "in_hours" });
  h.recipientsFor.mockResolvedValue(
    new Map([["c-dee", { cleanerId: "c-dee", firstName: "Dee", phone: "+12145550100", optedOut: false }]]),
  );
  h.textOffer.mockResolvedValue(true);
  h.wakeCleaner.mockResolvedValue(0);
});

describe("assigning an employee", () => {
  it("assigns, pricing the payout like the sweep and recording who did it", async () => {
    const response = await POST(request({ jobId: "job-1", cleanerId: "shonda" }));
    expect(response.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("assign_job_manually", {
      p_job_id: "job-1",
      p_cleaner_id: "shonda",
      p_payout_cents: 9900,
      p_by: "admin-1",
    });
    expect(h.textOffer).not.toHaveBeenCalled();
  });

  it("explains a refusal from the database", async () => {
    h.rpc.mockResolvedValue({ data: "already_assigned", error: null });
    const response = await POST(request({ jobId: "job-1", cleanerId: "shonda" }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/already has/);
  });
});

describe("choosing a contractor", () => {
  it("offers her the job instead of assigning her, and texts her", async () => {
    const response = await POST(request({ jobId: "job-1", cleanerId: "c-dee" }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("offered");

    expect(h.rpc).not.toHaveBeenCalledWith("assign_job_manually", expect.anything());
    expect(h.rpc).toHaveBeenCalledWith(
      "offer_job_manually",
      expect.objectContaining({ p_job_id: "job-1", p_cleaner_id: "c-dee", p_by: "admin-1" }),
    );
    expect(h.textOffer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ offerId: "offer-1", isExclusive: true }),
    );
  });

  it("refuses to offer to someone who can't be texted", async () => {
    h.recipientsFor.mockResolvedValue(new Map());
    const response = await POST(request({ jobId: "job-1", cleanerId: "c-dee" }));
    expect(response.status).toBe(409);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("waits out quiet hours rather than offer something she can't see", async () => {
    h.sendWindowFor.mockReturnValue({
      send: false,
      reason: "quiet_hours",
      nextOpening: new Date("2026-09-02T13:00:00Z"),
    });
    const response = await POST(request({ jobId: "job-1", cleanerId: "c-dee" }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/quiet hours/);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("explains a refusal from the database", async () => {
    h.rpc.mockResolvedValue({ data: [{ outcome: "ineligible", offer_id: null }], error: null });
    const response = await POST(request({ jobId: "job-1", cleanerId: "c-dee" }));
    expect(response.status).toBe(409);
    expect(h.textOffer).not.toHaveBeenCalled();
  });
});

describe("who may do this", () => {
  it("refuses anyone who is not an admin", async () => {
    h.repo.getCurrentProfile.mockResolvedValue({ id: "c-9", role: "cleaner" });
    const response = await POST(request({ jobId: "job-1", cleanerId: "shonda" }));
    expect(response.status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    h.repo.getCurrentProfile.mockResolvedValue(null);
    expect((await POST(request({ jobId: "job-1", cleanerId: "shonda" }))).status).toBe(401);
  });

  it("needs both a job and a cleaner", async () => {
    expect((await POST(request({ jobId: "job-1" }))).status).toBe(400);
  });
});

describe("demo mode", () => {
  beforeEach(() => {
    h.repo.isDemo = true;
  });

  it("remembers an employee assignment without touching a database", async () => {
    expect((await POST(request({ jobId: "job-1", cleanerId: "shonda" }))).status).toBe(200);
    expect(h.assignDemoJob).toHaveBeenCalledWith("job-1", "shonda");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("records a contractor offer, not an assignment", async () => {
    expect((await POST(request({ jobId: "job-1", cleanerId: "c-dee" }))).status).toBe(200);
    expect(h.offerDemoJob).toHaveBeenCalled();
    expect(h.assignDemoJob).not.toHaveBeenCalled();
  });
});
