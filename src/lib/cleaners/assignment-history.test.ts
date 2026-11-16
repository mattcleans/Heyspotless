import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAssignmentHistory } from "./assignment-history";
const row = { id: "old", previous_start: "2026-10-20T15:00:00Z", new_start: "2026-10-21T16:00:00Z", released_at: "2026-10-15T20:20:41Z", payout_cents: 7392 };
function client(results: { data: unknown; error: unknown }[]) {
  const queries: { table: string; select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; order: ReturnType<typeof vi.fn>; limit: ReturnType<typeof vi.fn> }[] = [];
  const from = vi.fn((table: string) => {
    const q = { table, select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn() };
    q.select.mockReturnValue(q); q.eq.mockReturnValue(q); q.order.mockReturnValue(q); q.limit.mockResolvedValue(results.shift() ?? { data: [], error: null });
    queries.push(q); return q;
  });
  return { db: { from } as unknown as SupabaseClient, from, queries };
}
describe("assignment history", () => {
  it("retains older agreements, scopes and bounds every table, and merges the three sources newest first", async () => {
    const { db, queries } = client([{ data: [row], error: null }, { data: [{ ...row, id: "series", new_start: null, released_at: "2026-11-01T12:00:00Z" }], error: null }, { data: [{ ...row, id: "crew", released_at: "2026-11-02T12:00:00Z" }], error: null }]);
    const records = await loadAssignmentHistory(db, "mine", true);
    expect(records.map(r => r.key)).toEqual(["crew_lead_releases:crew", "recurring_schedule_releases:series", "visit_reschedule_releases:old"]);
    expect(records.map(r => r.agreedCents)).toEqual([null, 7392, 7392]);
    for (const q of queries) { expect(q.eq).toHaveBeenCalledExactlyOnceWith("cleaner_id", "mine"); expect(q.limit).toHaveBeenCalledExactlyOnceWith(50); }
    expect(queries[0]?.select).toHaveBeenCalledWith("id,previous_start,new_start,released_at,payout_cents");
    expect(queries[2]?.select).toHaveBeenCalledWith("id,previous_start,new_start,released_at");
  });
  it("never fetches employee assignment pay or private home details", async () => {
    const { db, queries } = client([{ data: [row], error: null }]);
    expect((await loadAssignmentHistory(db, "mine", false))[0]?.agreedCents).toBeNull();
    for (const q of queries) expect(q.select).toHaveBeenCalledExactlyOnceWith("id,previous_start,new_start,released_at");
  });
  it("does not query without a connected identity", async () => {
    const { db, from } = client([]);
    await expect(loadAssignmentHistory(db, " ", true)).rejects.toThrow("connected"); expect(from).not.toHaveBeenCalled();
  });
  it.each(["42501", "42P01", "08006"])("exposes %s instead of claiming empty history", async code => {
    const { db } = client([{ data: null, error: { code } }]);
    await expect(loadAssignmentHistory(db, "mine", true)).rejects.toThrow("unavailable");
  });
  it.each([{ previous_start: "bad" }, { new_start: undefined }, { released_at: null }, { payout_cents: -1 }, { payout_cents: 1.5 }, { payout_cents: undefined }])("rejects malformed retained evidence %s", async change => {
    const { db } = client([{ data: [{ ...row, ...change }], error: null }]);
    await expect(loadAssignmentHistory(db, "mine", true)).rejects.toThrow("unavailable");
  });
  it("bounds combined output and uses distinct keys for overlapping source IDs", async () => {
    const data = Array.from({ length: 50 }, (_, i) => ({ ...row, id: `${i}` }));
    const { db } = client(Array.from({ length: 3 }, () => ({ data, error: null })));
    const records = await loadAssignmentHistory(db, "mine", true);
    expect(records).toHaveLength(50); expect(new Set(records.map(r => r.key)).size).toBe(50);
  });
});
