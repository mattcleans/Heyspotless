import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  loadCancellation,
  loadCancellationVisit,
  cancellationsForInvoices,
  listCancellations,
} from "./store";
let result: { data: unknown; error: { code: string } | null };
let calls: { method: string; args: unknown[] }[];
function db() {
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
  } as unknown as Parameters<typeof loadCancellation>[0];
}
const receipt = {
  id: "88000000-0000-0000-0000-000000000001",
  job_id: "85000000-0000-0000-0000-000000000001",
  reason: "cancel",
  scheduled_start: null,
  fee_cents: 0,
  invoice_id: null,
  billing_review: false,
  canceled_at: "2026-10-01T10:00:00Z",
};
beforeEach(() => {
  calls = [];
  result = { data: receipt, error: null };
});
describe("scoped cancellation reads", () => {
  it("loads one visit's confirmed receipt without provider identifiers or other clients' history", async () => {
    expect(await loadCancellation(db(), receipt.job_id)).toMatchObject({
      feeCents: 0,
      jobId: receipt.job_id,
    });
    expect(calls).toContainEqual({
      method: "eq",
      args: ["job_id", receipt.job_id],
    });
    const selected = String(calls.find((c) => c.method === "select")?.args[0]);
    expect(selected).not.toContain("confirmed_by");
    expect(selected).not.toContain("stripe");
  });
  it("absence is distinct from a failed read", async () => {
    result = { data: null, error: null };
    expect(await loadCancellation(db(), "job")).toBeNull();
    result = { data: null, error: { code: "08006" } };
    await expect(loadCancellation(db(), "job")).rejects.toThrow("unavailable");
  });
  it("billing account reads only loaded invoice jobs", async () => {
    result = { data: [receipt], error: null };
    await cancellationsForInvoices(db(), ["a", "a", "b"]);
    expect(calls).toContainEqual({
      method: "in",
      args: ["job_id", ["a", "b"]],
    });
  });
  it.each(["42P01", "PGRST205"])(
    "keeps existing account access before migration for %s",
    async (code) => {
      result = { data: null, error: { code } };
      expect(await cancellationsForInvoices(db(), ["job"])).toBeNull();
      await expect(listCancellations(db())).rejects.toThrow(
        "could not be loaded",
      );
    },
  );
  it("never substitutes no cancellations for a network failure", async () => {
    result = { data: null, error: { code: "08006" } };
    await expect(cancellationsForInvoices(db(), ["job"])).rejects.toThrow(
      "unavailable",
    );
  });
  it("does not query when there are no invoice jobs", async () => {
    expect(await cancellationsForInvoices(db(), [])).toEqual([]);
    expect(calls).toEqual([]);
  });
  it("office history is bounded and ordered", async () => {
    result = { data: [receipt], error: null };
    await listCancellations(db());
    expect(calls).toContainEqual({ method: "limit", args: [100] });
    expect(calls).toContainEqual({
      method: "order",
      args: ["canceled_at", { ascending: false }],
    });
  });
  it.each([
    {
      status: "assigned",
      started_at: null,
      recurring_plan_id: null,
      occurrence_date: null,
      closed: false,
    },
    {
      status: "assigned",
      started_at: "date",
      recurring_plan_id: null,
      occurrence_date: null,
      closed: true,
    },
    {
      status: "in_progress",
      started_at: null,
      recurring_plan_id: null,
      occurrence_date: null,
      closed: true,
    },
    {
      status: "canceled",
      started_at: null,
      recurring_plan_id: "plan",
      occurrence_date: "2026-10-01",
      closed: true,
    },
  ])("checks started work and actual plan linkage %j", async (row) => {
    result = { data: row, error: null };
    expect(await loadCancellationVisit(db(), "job")).toMatchObject({
      closed: row.closed,
      recurring: row.recurring_plan_id !== null,
    });
  });
});
