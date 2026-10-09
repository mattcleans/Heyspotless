import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { toClientSchedule, clientSchedules } from "./store";
const row = {
  active: true,
  id: "d9000000-0000-0000-0000-000000000001",
  customer_id: "d2000000-0000-0000-0000-000000000001",
  service: "standard",
  freq: "weekly",
  anchor_date: "2026-10-03",
  start_time: "09:30:00",
  paused_until: null,
  ends_on: null,
  agreed_price_cents: 20000,
  horizon_days: 42,
  properties: { street: "Sample Home", city: "Dallas" },
  recurring_plan_skips: [{ occurrence_date: "2026-10-10" }],
};
describe("request-scoped recurring reads", () => {
  it("keeps literal skipped dates, optional pauses and agreed price", () =>
    expect(toClientSchedule(row)).toMatchObject({
      priceCents: 20000,
      startTime: "09:30",
      skips: ["2026-10-10"],
    }));
  it.each([
    { properties: null },
    { anchor_date: "infinity" },
    { start_time: "24:00:00" },
    { horizon_days: 200 },
    { agreed_price_cents: NaN },
    { recurring_plan_skips: [{ occurrence_date: "2026-02-30" }] },
  ])("rejects incomplete terms %j", (bad) =>
    expect(() => toClientSchedule({ ...row, ...bad })).toThrow(),
  );
  it("scopes the safe read to its client and uses no service or pay columns", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [row], error: null });
    const db = { rpc } as unknown as Parameters<typeof clientSchedules>[0];
    expect((await clientSchedules(db, row.customer_id)).length).toBe(1);
    expect(rpc).toHaveBeenCalledWith("read_my_recurring_schedules", {
      p_plan: null,
      p_customer: row.customer_id,
    });
    expect(
      JSON.stringify(
        toClientSchedule({
          ...row,
          agreed_payout_share: 0.5,
          gate_code: "secret",
        }),
      ),
    ).not.toMatch(/payout|secret/);
  });
  it("rejects another client returned by an invalid response", async () => {
    const db = {
      rpc: async () => ({ data: [row], error: null }),
    } as unknown as Parameters<typeof clientSchedules>[0];
    await expect(clientSchedules(db, "other")).rejects.toThrow("verified");
  });
});
it("limits appointment history to the role-checked read and distinguishes missing schema from failure", async () => {
  const { recurringVisitChanges } = await import("./store");
  const rpc = vi.fn().mockResolvedValue({ data: [], error: null }),
    db = { rpc } as unknown as Parameters<typeof recurringVisitChanges>[0];
  expect(await recurringVisitChanges(db, "job")).toEqual([]);
  expect(rpc).toHaveBeenCalledWith("read_my_recurring_visit_changes", {
    p_job: "job",
  });
  rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
  expect(await recurringVisitChanges(db, "job")).toEqual([]);
  rpc.mockResolvedValue({ data: null, error: { code: "08006" } });
  await expect(recurringVisitChanges(db, "job")).rejects.toThrow(
    "could not be loaded",
  );
});
