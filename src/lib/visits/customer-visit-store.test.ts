import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadCustomerVisit } from "./customer-visit-store";
const id = "96000000-0000-0000-0000-000000000001";
const home = {
  street: "Sample St",
  city: "Dallas",
  zip: "75001",
  bedrooms: 0,
  bathrooms: 0,
  half_baths: 1,
  kitchens: 2,
  living_rooms: 0,
  utility_rooms: 0,
};
type Table =
  "jobs" | "client_visit_assignments" | "job_photos" | "visit_backup_status";
let results: Record<Table, { data: unknown; error: unknown }>;
let calls: { table: string; method: string; args: unknown[] }[];
function db() {
  return {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const method of [
        "select",
        "eq",
        "in",
        "order",
        "limit",
        "maybeSingle",
      ]) {
        q[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return q;
        };
      }
      q.then = (resolve: (v: unknown) => void) =>
        resolve(results[table as Table]);
      return q;
    },
  } as unknown as Parameters<typeof loadCustomerVisit>[0];
}
beforeEach(() => {
  calls = [];
  results = {
    visit_backup_status: { error: null, data: [] },
    jobs: {
      error: null,
      data: {
        id,
        status: "in_progress",
        property_id: "home",
        scheduled_start: "2026-10-01T14:00:00Z",
        started_at: "2026-10-01T14:04:00Z",
        completed_at: null,
        estimated_clean_minutes: 90,
        properties: home,
      },
    },
    client_visit_assignments: {
      error: null,
      data: [{ cleaner_id: "cleaner", full_name: "Sample Cleaner" }],
    },
    job_photos: {
      error: null,
      data: [
        { room_key: "kitchen_1", kind: "before" },
        { room_key: "kitchen_2", kind: "before" },
        { room_key: "kitchen_2", kind: "after" },
      ],
    },
  };
});
describe("request-scoped client visit reads", () => {
  it("reads only this visit and required room/photo kinds with exact bounded limits", async () => {
    const visit = await loadCustomerVisit(db(), id);
    expect(visit?.summary.roomsDone).toBe(1);
    expect(visit?.summary.roomsTotal).toBe(3);
    expect(visit?.summary.expectedFinishAt?.toISOString()).toBe(
      "2026-10-01T15:34:00.000Z",
    );
    expect(visit?.address).toBe("Sample St, Dallas 75001");
    expect(calls).toContainEqual({
      table: "jobs",
      method: "eq",
      args: ["id", id],
    });
    for (const table of ["client_visit_assignments", "job_photos"])
      expect(calls).toContainEqual({
        table,
        method: "eq",
        args: ["job_id", id],
      });
    expect(calls).toContainEqual({
      table: "job_photos",
      method: "in",
      args: ["room_key", ["kitchen_1", "kitchen_2", "half_bath_1"]],
    });
    expect(calls).toContainEqual({
      table: "job_photos",
      method: "in",
      args: ["kind", ["before", "after"]],
    });
    expect(calls).toContainEqual({
      table: "job_photos",
      method: "limit",
      args: [6],
    });
    expect(calls).toContainEqual({
      table: "client_visit_assignments",
      method: "limit",
      args: [2],
    });
    expect(JSON.stringify(calls)).not.toContain("storage_path");
    expect(JSON.stringify(calls)).not.toContain("payout");
  });
  it("surfaces an unapproved backup without inventing client consent", async () => {
    results.visit_backup_status.data = [
      {
        backup_name: "Backup",
        preferred_name: "Preferred",
        approved: false,
        decision_id: "decline",
      },
    ];
    expect((await loadCustomerVisit(db(), id))?.backup).toEqual({
      name: "Backup",
      preferredName: "Preferred",
      approved: false,
      declined: true,
    });
  });
  it("does not read assignments or photos for an inaccessible visit", async () => {
    results.jobs.data = null;
    expect(await loadCustomerVisit(db(), id)).toBeNull();
    expect(calls.every((c) => c.table === "jobs")).toBe(true);
  });
  it.each([
    "jobs",
    "client_visit_assignments",
    "job_photos",
    "visit_backup_status",
  ] as const)("does not turn %s errors into empty progress", async (table) => {
    results[table].error = { message: "denied" };
    await expect(loadCustomerVisit(db(), id)).rejects.toThrow("Unable to load");
  });
  it.each([
    "client_visit_assignments",
    "job_photos",
    "visit_backup_status",
  ] as const)("rejects unreadable %s results", async (table) => {
    results[table].data = null;
    await expect(loadCustomerVisit(db(), id)).rejects.toThrow("Unable to load");
  });
  it("labels assignment data unavailable while the safe view is awaiting deployment", async () => {
    results.client_visit_assignments = {
      data: null,
      error: { code: "PGRST205" },
    };
    const visit = await loadCustomerVisit(db(), id);
    expect(visit?.assignmentUnavailable).toBe(true);
    expect(visit?.cleanerId).toBeNull();
    expect(visit?.summary.roomsDone).toBe(1);
  });
  it("does not invent counts when property is missing", async () => {
    (results.jobs.data as Record<string, unknown>).properties = null;
    await expect(loadCustomerVisit(db(), id)).rejects.toThrow("Unable to load");
    expect(calls.every((c) => c.table === "jobs")).toBe(true);
  });
  it("supports array relations", async () => {
    (results.jobs.data as Record<string, unknown>).properties = [home];
    expect((await loadCustomerVisit(db(), id))?.rooms).toHaveLength(3);
  });
  it.each([null, "2", -1, 0.5, Number.MAX_SAFE_INTEGER])(
    "rejects invalid configured count %s without photo reads",
    async (kitchens) => {
      (results.jobs.data as Record<string, unknown>).properties = {
        ...home,
        kitchens,
      };
      await expect(loadCustomerVisit(db(), id)).rejects.toThrow();
      expect(calls.every((c) => c.table === "jobs")).toBe(true);
    },
  );
  it("does not arbitrarily name one of two lead cleaners", async () => {
    results.client_visit_assignments.data = [
      { cleaner_id: "one" },
      { cleaner_id: "two" },
    ];
    await expect(loadCustomerVisit(db(), id)).rejects.toThrow(
      "assignment needs review",
    );
  });
  it("keeps an assigned visit assigned when profile/assignment data is absent", async () => {
    Object.assign(results.jobs.data as object, {
      status: "assigned",
      started_at: null,
    });
    results.client_visit_assignments.data = [];
    const visit = await loadCustomerVisit(db(), id);
    expect(visit?.cleanerId).toBeNull();
    expect(visit?.summary.stage).toBe("accepted");
    expect(visit?.summary.expectedFinishAt).toBeNull();
  });
  it("preserves cancellation even when work started and a cleaner was assigned", async () => {
    (results.jobs.data as Record<string, unknown>).status = "canceled";
    expect((await loadCustomerVisit(db(), id))?.summary.stage).toBe("canceled");
  });
  it("does not force a completed visit's evidence to full", async () => {
    Object.assign(results.jobs.data as object, {
      status: "complete",
      completed_at: "2026-10-01T16:00:00Z",
    });
    const visit = await loadCustomerVisit(db(), id);
    expect(visit?.summary.stage).toBe("done");
    expect(visit?.summary.roomsDone).toBe(1);
  });
  it("handles zero rooms without querying photos", async () => {
    (results.jobs.data as Record<string, unknown>).properties = {
      ...home,
      kitchens: 0,
      half_baths: 0,
    };
    const visit = await loadCustomerVisit(db(), id);
    expect(visit?.summary.roomsTotal).toBe(0);
    expect(calls.some((c) => c.table === "job_photos")).toBe(false);
  });
  it("rejects invalid timing rather than rendering an invalid date", async () => {
    (results.jobs.data as Record<string, unknown>).started_at = "bad";
    await expect(loadCustomerVisit(db(), id)).rejects.toThrow("Unable to load");
  });
});
