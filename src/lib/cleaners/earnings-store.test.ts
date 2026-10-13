import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCleanerPay } from "./earnings-store";

type Result = { data: Record<string, unknown>[] | null; error: { code: string; message: string } | null };
const empty: Result = { data: [], error: null };
const record = { id: "p1", job_id: null, amount_cents: 8000, mileage_cents: 0, tip_cents: 0, tip_fee_cents: 0, tip_net_cents: 0, created_at: "2026-10-01T15:00:00Z", paid_at: null };
function client(results: Result[]) {
  const queries: { table: string; select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; order: ReturnType<typeof vi.fn>; limit: ReturnType<typeof vi.fn> }[] = [];
  const from = vi.fn((table: string) => {
    const result = results.shift() ?? empty;
    const query = { table, select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn() };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.order.mockReturnValue(query); query.limit.mockResolvedValue(result);
    queries.push(query);
    return query;
  });
  return { db: { from } as unknown as SupabaseClient, from, queries };
}
describe("scoped pay reads", () => {
  it("applies the authenticated cleaner identity to both reads and bounds their size", async () => {
    const { db, queries } = client([{ data: [record], error: null }, empty]);
    const pay = await loadCleanerPay(db, "my-cleaner");
    expect(pay.records).toHaveLength(1);
    expect(queries.map(query => query.table)).toEqual(["payouts", "job_assignments"]);
    for (const query of queries) {
      expect(query.eq).toHaveBeenCalledWith("cleaner_id", "my-cleaner");
      expect(query.limit).toHaveBeenCalledWith(200);
    }
  });
  it("never performs an unscoped read without a cleaner identity", async () => {
    const { db, from } = client([]);
    await expect(loadCleanerPay(db, "")).rejects.toThrow("connected");
    expect(from).not.toHaveBeenCalled();
  });
  it("supports the older ledger while preserving unknown tip amounts", async () => {
    const { db, queries } = client([{ data: null, error: { code: "42703", message: "column payouts.tip_cents does not exist" } }, empty, { data: [record], error: null }]);
    const pay = await loadCleanerPay(db, "mine");
    expect(pay.tipsAvailable).toBe(false);
    expect(pay.records[0]?.tipNetCents).toBeNull();
    expect(queries[2]?.select).toHaveBeenCalledWith(expect.not.stringContaining("tip_cents"));
    expect(queries[2]?.eq).toHaveBeenCalledWith("cleaner_id", "mine");
  });
  it.each([{ code: "42501", message: "permission denied" }, { code: "42703", message: "column paid_at does not exist" }, { code: "08006", message: "connection failed" }])("does not turn database error %s into an empty pay statement", async error => {
    const { db, from } = client([{ data: null, error }, empty]);
    await expect(loadCleanerPay(db, "mine")).rejects.toThrow("Unable to load");
    expect(from).toHaveBeenCalledTimes(2);
  });
  it("fails visibly when assignment pay cannot be loaded", async () => {
    const { db } = client([empty, { data: null, error: { code: "42501", message: "denied" } }]);
    await expect(loadCleanerPay(db, "mine")).rejects.toThrow("Unable to load");
  });
});
