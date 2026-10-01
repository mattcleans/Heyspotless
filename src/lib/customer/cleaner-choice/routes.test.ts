import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({
  repo: vi.fn(),
  client: vi.fn(),
  rpc: vi.fn(),
  job: vi.fn(),
  customer: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
import { POST as preference } from "@/app/api/customer/visits/[id]/cleaner-request/route";
import { POST as backup } from "@/app/api/customer/visits/[id]/backup/route";
import { POST as review } from "@/app/api/admin/cleaner-requests/[id]/route";
import { POST as release } from "@/app/api/admin/visits/[id]/release-backup/route";
const id = "95000000-0000-0000-0000-000000000001",
  cleanerId = "94000000-0000-0000-0000-000000000001",
  eventId = "98000000-0000-0000-0000-000000000001",
  assignmentId = "97000000-0000-0000-0000-000000000001";
const pref = {
  cleanerId,
  id: eventId,
  note: " Usual cleaner ",
  expectedLatest: null,
};
const consent = {
  assignmentId,
  preferredCleanerId: cleanerId,
  backupCleanerId: "94000000-0000-0000-0000-000000000002",
  id: eventId,
  accept: true,
  note: "",
  expectedLatest: null,
};
const releaseBody = { ...consent, decisionId: eventId };
function account(role: string | null, demo = false) {
  m.repo.mockResolvedValue({
    isDemo: demo,
    getCurrentProfile: async () => (role ? { id: "profile", role } : null),
    getCustomerByProfile: m.customer,
    getJob: m.job,
  });
}
function save(
  route: (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>,
  body: unknown,
  recordId = id,
) {
  return route(
    new NextRequest("https://app.example.test/api/choice", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: recordId }) },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  account("customer");
  m.customer.mockResolvedValue({ id: "own" });
  m.job.mockResolvedValue({ id, customerId: "own" });
  m.client.mockResolvedValue({ rpc: m.rpc });
  m.rpc.mockResolvedValue({
    data: { id: eventId, status: "pending", accepted: true },
    error: null,
  });
});
for (const [label, route, body] of [
  ["preference", preference, pref],
  ["backup", backup, consent],
] as const)
  describe(label, () => {
    it.each([
      [null, 401],
      ["admin", 403],
      ["cleaner", 403],
    ] as const)(
      "rejects %s before visit reads or writes",
      async (role, status) => {
        account(role);
        expect((await save(route, body)).status).toBe(status);
        expect(m.job).not.toHaveBeenCalled();
        expect(m.client).not.toHaveBeenCalled();
      },
    );
    it("rejects preview writes", async () => {
      account("customer", true);
      expect((await save(route, body)).status).toBe(409);
      expect(m.rpc).not.toHaveBeenCalled();
    });
    it("rejects unlinked profiles", async () => {
      m.customer.mockResolvedValue(null);
      expect((await save(route, body)).status).toBe(403);
      expect(m.job).not.toHaveBeenCalled();
    });
    it.each([null, { customerId: "other" }])(
      "rejects inaccessible or another client's visit %j",
      async (job) => {
        m.job.mockResolvedValue(job);
        expect((await save(route, body)).status).toBe(404);
        expect(m.rpc).not.toHaveBeenCalled();
      },
    );
    it("rejects malformed visit IDs", async () => {
      expect((await save(route, body, "bad")).status).toBe(400);
      expect(m.job).not.toHaveBeenCalled();
    });
    it.each([
      null,
      {},
      [],
      { ...body, note: "x".repeat(501) },
      { ...body, expectedLatest: undefined },
      { ...body, expectedLatest: "stale" },
    ])("rejects malformed payload %j", async (b) => {
      expect((await save(route, b)).status).toBe(400);
      expect(m.rpc).not.toHaveBeenCalled();
    });
    it.each([
      ["42501", 403],
      ["40001", 409],
      ["23514", 409],
      ["22023", 400],
      ["08006", 500],
    ] as const)("preserves failed saves for code %s", async (code, status) => {
      m.rpc.mockResolvedValue({
        error: { code, message: "PRIVATE DATABASE DETAILS" },
        data: null,
      });
      const response = await save(route, body);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("PRIVATE DATABASE DETAILS");
    });
    it.each([null, {}, { id: "other", status: "pending", accepted: true }])(
      "requires the saved receipt %j",
      async (data) => {
        m.rpc.mockResolvedValue({ error: null, data });
        expect((await save(route, body)).status).toBe(500);
      },
    );
  });
describe("RPC authority and identities", () => {
  it("passes only visit, chosen cleaner, event, original state and trimmed note", async () => {
    expect(
      (
        await save(preference, {
          ...pref,
          customerId: "forged",
          requestedBy: "admin",
          status: "applied",
        })
      ).status,
    ).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("request_my_visit_cleaner", {
      p_job_id: id,
      p_cleaner_id: cleanerId,
      p_id: eventId,
      p_note: "Usual cleaner",
      p_expected_latest: null,
    });
  });
  it("ties backup approval to the reviewed cleaner as well as assignment/preference", async () => {
    expect((await save(backup, consent)).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("respond_my_visit_backup", {
      p_job_id: id,
      p_assignment_id: assignmentId,
      p_preferred_cleaner_id: cleanerId,
      p_backup_cleaner_id: consent.backupCleanerId,
      p_id: eventId,
      p_accept: true,
      p_note: "",
      p_expected_latest: null,
    });
  });
  it("rejects a receipt reporting the opposite decision", async () => {
    m.rpc.mockResolvedValue({
      error: null,
      data: { id: eventId, accepted: false },
    });
    expect((await save(backup, consent)).status).toBe(500);
  });
  it("accepts an idempotent preference retry that was already reviewed", async () => {
    m.rpc.mockResolvedValue({
      error: null,
      data: { id: eventId, status: "applied" },
    });
    expect(await (await save(preference, pref)).json()).toMatchObject({
      saved: true,
      status: "applied",
    });
  });
});
for (const [label, route, body] of [
  ["review", review, { apply: true, note: " Eligible preference " }],
  ["release", release, releaseBody],
] as const)
  describe(`office ${label}`, () => {
    it.each([
      [null, 401],
      ["customer", 403],
      ["cleaner", 403],
    ] as const)("rejects %s before writes", async (role, status) => {
      account(role);
      expect((await save(route, body)).status).toBe(status);
      expect(m.client).not.toHaveBeenCalled();
    });
    it("rejects malformed identifiers before writes", async () => {
      account("admin");
      expect((await save(route, body, "bad")).status).toBe(404);
      expect(m.rpc).not.toHaveBeenCalled();
    });
    it("requires an authoritative database outcome", async () => {
      account("admin");
      m.rpc.mockResolvedValue({ data: null, error: null });
      expect((await save(route, body)).status).toBe(500);
    });
    it("returns a conflict if assignment or review changed", async () => {
      account("admin");
      m.rpc.mockResolvedValue({ data: null, error: { code: "40001" } });
      expect((await save(route, body)).status).toBe(409);
    });
  });
describe("office saved choices", () => {
  it("reviews a preference without creating an assignment", async () => {
    account("admin");
    m.rpc.mockResolvedValue({ data: { id, status: "applied" }, error: null });
    expect(
      (await save(review, { apply: true, note: " Eligible preference " }))
        .status,
    ).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("review_visit_cleaner_request", {
      p_id: id,
      p_apply: true,
      p_note: "Eligible preference",
    });
  });
  it("requires a client-facing review explanation", async () => {
    account("admin");
    expect((await save(review, { apply: true, note: " " })).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("releases only the exact reviewed decline", async () => {
    account("admin");
    m.rpc.mockResolvedValue({ data: true, error: null });
    expect((await save(release, releaseBody)).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("release_declined_visit_backup", {
      p_job_id: id,
      p_assignment_id: assignmentId,
      p_preferred_cleaner_id: cleanerId,
      p_backup_cleaner_id: consent.backupCleanerId,
      p_decision_id: eventId,
    });
  });
});
