import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { repo, rpc, assignDemoJob } = vi.hoisted(() => ({
  repo: {
    isDemo: false,
    getCurrentProfile: vi.fn(),
    getJob: vi.fn(),
  },
  rpc: vi.fn(),
  assignDemoJob: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: async () => repo }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));
vi.mock("@/lib/demo/added", () => ({ assignDemoJob }));
import { POST } from "./route";

const request = (body: unknown) =>
  new NextRequest("https://app.example.test/api/dispatch/assign", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  repo.isDemo = false;
  repo.getCurrentProfile.mockReset().mockResolvedValue({ id: "admin-1", role: "admin" });
  repo.getJob.mockReset().mockResolvedValue({ id: "job-1", priceCents: 30000 });
  rpc.mockReset().mockResolvedValue({ data: "assigned", error: null });
  assignDemoJob.mockReset();
});

describe("manual assignment", () => {
  it("assigns, pricing the payout like the sweep and recording who did it", async () => {
    const response = await POST(request({ jobId: "job-1", cleanerId: "c-1" }));
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("assign_job_manually", {
      p_job_id: "job-1",
      p_cleaner_id: "c-1",
      p_payout_cents: 9900,
      p_by: "admin-1",
    });
  });

  it("refuses anyone who is not an admin", async () => {
    repo.getCurrentProfile.mockResolvedValue({ id: "c-9", role: "cleaner" });
    const response = await POST(request({ jobId: "job-1", cleanerId: "c-1" }));
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    repo.getCurrentProfile.mockResolvedValue(null);
    expect((await POST(request({ jobId: "job-1", cleanerId: "c-1" }))).status).toBe(401);
  });

  it("needs both a job and a cleaner", async () => {
    expect((await POST(request({ jobId: "job-1" }))).status).toBe(400);
  });

  it("explains a refusal from the database", async () => {
    rpc.mockResolvedValue({ data: "already_assigned", error: null });
    const response = await POST(request({ jobId: "job-1", cleanerId: "c-1" }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/already has/);
  });

  it("remembers the assignment in demo mode without touching a database", async () => {
    repo.isDemo = true;
    const response = await POST(request({ jobId: "job-1", cleanerId: "c-1" }));
    expect(response.status).toBe(200);
    expect(assignDemoJob).toHaveBeenCalledWith("job-1", "c-1");
    expect(rpc).not.toHaveBeenCalled();
  });
});
