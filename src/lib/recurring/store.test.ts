import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toCalendarDate } from "../time/zone";
vi.mock("server-only", () => ({}));
import { RecurringStore } from "./store";
const id = "b9000000-0000-0000-0000-000000000001";
const rpc = vi.fn();
const date = toCalendarDate("2026-09-22")!;
const start = new Date("2026-09-22T14:30Z");
const row = {
  id,
  customer_id: id,
  property_id: id,
  freq: "weekly",
  anchor_date: "2026-09-15",
  start_time: "09:30:00",
  ends_on: null,
  paused_until: null,
  active: true,
  horizon_days: 42,
  schedule_revision: 2,
};
function store(plan: unknown = row) {
  const q = {
    select: () => q,
    eq: () => q,
    limit: async () => ({ data: [plan], error: null }),
    in: async () => ({ data: [], error: null }),
  };
  return new RecurringStore({
    from: () => q,
    rpc,
  } as unknown as SupabaseClient);
}
beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: [{ job_id: id, created: true }], error: null });
});
describe("recurring generation versions", () => {
  it("carries the loaded plan revision into the locked database write", async () => {
    const s = store();
    expect((await s.listActivePlans())[0]?.scheduleRevision).toBe(2);
    expect(await s.materialise(id, date, start, 2)).toEqual({
      jobId: id,
      created: true,
    });
    expect(rpc).toHaveBeenCalledWith("materialise_recurring_job_for_revision", {
      p_plan_id: id,
      p_occurrence_date: date,
      p_scheduled_start: start.toISOString(),
      p_schedule_revision: 2,
    });
  });
  it("does not fall back to an unversioned RPC when a migration is missing", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "function missing" },
    });
    await expect(store().materialise(id, date, start, 2)).rejects.toThrow(
      "function missing",
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    [],
    [{ job_id: id, created: "true" }],
    [{ job_id: null, created: true }],
    [{ job_id: "invalid", created: false }],
    [
      { job_id: id, created: true },
      { job_id: id, created: true },
    ],
  ])("never counts malformed receipt %j as a skip", async (data) => {
    rpc.mockResolvedValue({ data, error: null });
    await expect(store().materialise(id, date, start, 2)).rejects.toThrow(
      "invalid generation receipt",
    );
  });
  it("accepts an explicit suppression receipt", async () => {
    rpc.mockResolvedValue({
      data: [{ job_id: null, created: false }],
      error: null,
    });
    expect(await store().materialise(id, date, start, 2)).toEqual({
      jobId: null,
      created: false,
    });
  });
  it.each([
    { schedule_revision: undefined },
    { schedule_revision: 0 },
    { start_time: "24:00:00" },
    { freq: "unknown" },
    { ends_on: "infinity" },
    { horizon_days: 0 },
  ])("refuses unsafe generation settings %j", async (invalid) => {
    await expect(
      store({ ...row, ...invalid }).listActivePlans(),
    ).rejects.toThrow("invalid generation settings");
  });
});
