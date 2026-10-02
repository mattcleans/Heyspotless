import { beforeEach, describe, expect, it } from "vitest";
import {
  loadRescheduleVisit,
  rescheduleHistory,
  releasedVisits,
} from "./store";
let result: { data: unknown; error: { code: string } | null },
  calls: { method: string; args: unknown[] }[];
function db() {
  const q: Record<string, unknown> = {};
  for (const method of [
    "select",
    "eq",
    "gte",
    "order",
    "limit",
    "maybeSingle",
  ]) {
    q[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return q;
    };
  }
  q.then = (resolve: (v: unknown) => void) => resolve(result);
  return {
    from: (table: string) => {
      calls.push({ method: "from", args: [table] });
      return q;
    },
  } as unknown as Parameters<typeof rescheduleHistory>[0];
}
beforeEach(() => {
  calls = [];
  result = { data: [], error: null };
});
describe("request-scoped reschedule reads", () => {
  it("loads only the visit's latest five saved changes without private pay", async () => {
    await rescheduleHistory(db(), "own");
    expect(calls).toContainEqual({ method: "eq", args: ["job_id", "own"] });
    expect(calls).toContainEqual({ method: "limit", args: [5] });
    expect(JSON.stringify(calls)).not.toMatch(
      /assignment_snapshot|payout|confirmed_by/,
    );
  });
  it("requires a successful history read", async () => {
    result = { data: null, error: { code: "08006" } };
    await expect(rescheduleHistory(db(), "own")).rejects.toThrow("unavailable");
  });
  it.each(["in_progress", "complete", "canceled"])(
    "%s has no reschedule actions",
    async (status) => {
      result = {
        data: {
          status,
          started_at: null,
          recurring_plan_id: null,
          occurrence_date: null,
        },
        error: null,
      };
      expect((await loadRescheduleVisit(db(), "own")).closed).toBe(true);
    },
  );
  it("actual starts prevent rescheduling even if status is stale", async () => {
    result = {
      data: {
        status: "assigned",
        started_at: "2026-10-01T12:00Z",
        recurring_plan_id: null,
        occurrence_date: null,
      },
      error: null,
    };
    expect((await loadRescheduleVisit(db(), "own")).closed).toBe(true);
  });
  it("does not infer a recurring plan from a frequency label", async () => {
    result = {
      data: {
        status: "scheduled",
        started_at: null,
        recurring_plan_id: null,
        occurrence_date: null,
      },
      error: null,
    };
    expect((await loadRescheduleVisit(db(), "own")).recurring).toBe(false);
  });
  it("limits cleaner changes to their own recent releases", async () => {
    await releasedVisits(db(), "cleaner");
    expect(calls).toContainEqual({
      method: "eq",
      args: ["cleaner_id", "cleaner"],
    });
    expect(calls).toContainEqual({ method: "limit", args: [10] });
    expect(
      calls.some((x) => x.method === "gte" && x.args[0] === "released_at"),
    ).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(/payout|gate_code|access_notes/);
  });
  it("older deployments without the new release table keep cleaner home usable", async () => {
    result = { data: null, error: { code: "PGRST205" } };
    expect(await releasedVisits(db(), "cleaner")).toEqual([]);
  });
  it("does not suppress a real failure as an empty schedule change list", async () => {
    result = { data: null, error: { code: "08006" } };
    await expect(releasedVisits(db(), "cleaner")).rejects.toThrow(
      "Refresh before heading",
    );
  });
});
it("shows removed recurring assignments with no replacement time", async () => {
  result = {
    data: [
      {
        id: "released",
        previous_start: "2026-10-05T14:30Z",
        new_start: null,
        released_at: "2026-10-02T14:00Z",
      },
    ],
    error: null,
  };
  const changes = await releasedVisits(db(), "cleaner");
  expect(changes[0]!.newStart).toBeNull();
  expect(calls).toContainEqual({
    method: "from",
    args: ["recurring_schedule_releases"],
  });
});
