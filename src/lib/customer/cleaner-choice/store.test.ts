import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadVisitChoice, listChoiceReview } from "./store";
type Result = { data: unknown; error: unknown };
type Table =
  | "jobs"
  | "client_visit_assignments"
  | "visit_cleaner_requests"
  | "visit_backup_status"
  | "visit_backup_decisions";
let results: Record<Table, Result>,
  calls: { table: string; method: string; args: unknown[] }[];
function db() {
  return {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const method of [
        "select",
        "eq",
        "is",
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
  } as unknown as Parameters<typeof loadVisitChoice>[0];
}
beforeEach(() => {
  calls = [];
  results = {
    jobs: {
      error: null,
      data: {
        status: "assigned",
        started_at: null,
        preferred_cleaner_id: "preferred",
      },
    },
    client_visit_assignments: {
      error: null,
      data: [{ id: "assignment", cleaner_id: "backup", full_name: "Backup" }],
    },
    visit_cleaner_requests: {
      error: null,
      data: [
        {
          id: "request",
          cleaner_id: "preferred",
          cleaner_name: "Preferred",
          status: "applied",
          note: "",
          decision_note: "Matching preference applied",
        },
      ],
    },
    visit_backup_status: {
      error: null,
      data: [
        {
          assignment_id: "assignment",
          preferred_cleaner_id: "preferred",
          backup_cleaner_id: "backup",
          preferred_name: "Preferred",
          backup_name: "Backup",
          approved: false,
          decision_id: null,
          unambiguous: true,
        },
      ],
    },
    visit_backup_decisions: { error: null, data: [] },
  };
});
describe("scoped cleaner choices", () => {
  it("restores only the current assignment decision's saved office note", async () => {
    (
      results.visit_backup_status.data as Record<string, unknown>[]
    )[0]!.decision_id = "decision";
    results.visit_backup_decisions.data = {
      note: "Please use the side entrance",
    };
    expect((await loadVisitChoice(db(), "visit"))?.backup?.note).toBe(
      "Please use the side entrance",
    );
    for (const [field, value] of [
      ["id", "decision"],
      ["job_id", "visit"],
      ["assignment_key", "assignment"],
      ["preferred_cleaner_id", "preferred"],
      ["backup_cleaner_id", "backup"],
    ])
      expect(calls).toContainEqual({
        table: "visit_backup_decisions",
        method: "eq",
        args: [field, value],
      });
  });
  it("starts a new assignment with an empty note rather than reading old decisions", async () => {
    results.visit_backup_decisions.data = { note: "Old cleaner's note" };
    expect((await loadVisitChoice(db(), "visit"))?.backup?.note).toBe("");
    expect(calls.some((c) => c.table === "visit_backup_decisions")).toBe(false);
  });
  it.each([
    { data: null, error: null },
    { data: null, error: { message: "denied" } },
    { data: { note: null }, error: null },
    { data: { note: 42 }, error: null },
  ])("does not turn an unreadable saved decision into a blank note: %j", async (result) => {
    (
      results.visit_backup_status.data as Record<string, unknown>[]
    )[0]!.decision_id = "decision";
    results.visit_backup_decisions = result;
    await expect(loadVisitChoice(db(), "visit")).rejects.toThrow(
      "could not be loaded",
    );
  });
  it("reads only own-visit identities and public names, not assignment pay or client actor IDs", async () => {
    const choice = await loadVisitChoice(db(), "visit");
    expect(choice?.backup?.approved).toBe(false);
    expect(choice?.assigned?.name).toBe("Backup");
    for (const table of [
      "client_visit_assignments",
      "visit_cleaner_requests",
      "visit_backup_status",
    ])
      expect(calls).toContainEqual({
        table,
        method: "eq",
        args: ["job_id", "visit"],
      });
    expect(JSON.stringify(calls)).not.toMatch(/payout|requested_by|decided_by/);
    expect(calls).toContainEqual({
      table: "visit_cleaner_requests",
      method: "order",
      args: ["version", { ascending: false }],
    });
  });
  it("does not read any choices for a missing visit", async () => {
    results.jobs.data = null;
    expect(await loadVisitChoice(db(), "visit")).toBeNull();
    expect(calls.every((c) => c.table === "jobs")).toBe(true);
  });
  it.each([
    "jobs",
    "client_visit_assignments",
    "visit_cleaner_requests",
    "visit_backup_status",
  ])("fails on %s read errors", async (table) => {
    results[table as Table].error = { message: "denied" };
    await expect(loadVisitChoice(db(), "visit")).rejects.toThrow(
      "could not be loaded",
    );
  });
  it.each(["client_visit_assignments", "visit_backup_status"])(
    "refuses ambiguous %s",
    async (table) => {
      const data = results[table as Table].data as object[];
      results[table as Table].data = [...data, ...data];
      await expect(loadVisitChoice(db(), "visit")).rejects.toThrow(
        "office review",
      );
    },
  );
  it.each([null, "true", 1])(
    "does not interpret %s as backup approval",
    async (approved) => {
      (
        results.visit_backup_status.data as Record<string, unknown>[]
      )[0]!.approved = approved;
      await expect(loadVisitChoice(db(), "visit")).rejects.toThrow();
    },
  );
  it("does not assume missing results are no backup", async () => {
    results.visit_backup_status.data = null;
    await expect(loadVisitChoice(db(), "visit")).rejects.toThrow();
  });
  it("rejects malformed start time", async () => {
    (results.jobs.data as Record<string, unknown>).started_at = "bad";
    await expect(loadVisitChoice(db(), "visit")).rejects.toThrow();
  });
  it("supports an unassigned visit with no previous choices", async () => {
    for (const table of [
      "client_visit_assignments",
      "visit_cleaner_requests",
      "visit_backup_status",
    ])
      results[table as Table].data = [];
    expect(await loadVisitChoice(db(), "visit")).toMatchObject({
      assigned: null,
      request: null,
      backup: null,
    });
  });
});
describe("office choice queue", () => {
  beforeEach(() => {
    results.visit_cleaner_requests.data = [];
    results.visit_backup_status.data = [
      {
        job_id: "visit",
        customer_name: "Client",
        street: "Sample",
        city: "Dallas",
        backup_name: "Backup",
        preferred_name: "Preferred",
        assignment_id: "assignment",
        preferred_cleaner_id: "preferred",
        backup_cleaner_id: "backup",
        decision_id: "decision",
        unambiguous: true,
        release_allowed: true,
      },
    ];
    results.visit_backup_decisions.data = [
      { id: "decision", note: "Different cleaner please" },
    ];
  });
  it("shows the client decline note with exact release identities and bounded reads", async () => {
    expect((await listChoiceReview(db())).backups[0]).toMatchObject({
      declined: true,
      canRelease: true,
      clientNote: "Different cleaner please",
      decisionId: "decision",
      assignmentId: "assignment",
    });
    expect(calls).toContainEqual({
      table: "visit_backup_status",
      method: "eq",
      args: ["approved", false],
    });
    expect(calls).toContainEqual({
      table: "visit_backup_status",
      method: "is",
      args: ["started_at", null],
    });
    expect(calls).toContainEqual({
      table: "visit_backup_decisions",
      method: "in",
      args: ["id", ["decision"]],
    });
  });
  it("does not turn a denied private note read into an empty note", async () => {
    results.visit_backup_decisions.error = { message: "denied" };
    await expect(listChoiceReview(db())).rejects.toThrow();
  });
  it("does not offer release for a crew", async () => {
    (
      results.visit_backup_status.data as Record<string, unknown>[]
    )[0]!.release_allowed = false;
    expect((await listChoiceReview(db())).backups[0]!.canRelease).toBe(false);
  });
});
