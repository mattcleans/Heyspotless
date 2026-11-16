import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export const ASSIGNMENT_HISTORY_LIMIT = 50;
export const ASSIGNMENT_HISTORY_ERROR = "Assignment changes are unavailable. Refresh this page or call the office for your earlier agreements.";
export interface AssignmentChange {
  key: string;
  kind: "schedule" | "crew";
  previousStart: string | null;
  newStart: string | null;
  releasedAt: string;
  agreedCents: number | null;
}
function dateOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}
/** Request-bound client only: each table also enforces own-Cleaner RLS. */
export async function loadAssignmentHistory(db: SupabaseClient, cleanerId: string, includeAgreedPay: boolean): Promise<AssignmentChange[]> {
  if (!cleanerId.trim()) throw new Error("Your Cleaner profile must be connected before assignment changes can load.");
  const groups = await Promise.all(["visit_reschedule_releases", "recurring_schedule_releases", "crew_lead_releases"].map(async table => {
    const hasPay = includeAgreedPay && table !== "crew_lead_releases";
    const { data, error } = await db.from(table)
      .select(`id,previous_start,new_start,released_at${hasPay ? ",payout_cents" : ""}`)
      .eq("cleaner_id", cleanerId)
      .order("released_at", { ascending: false }).order("id", { ascending: false })
      .limit(ASSIGNMENT_HISTORY_LIMIT);
    if (error || !Array.isArray(data)) throw new Error(ASSIGNMENT_HISTORY_ERROR);
    return data.map((raw): AssignmentChange => {
      if (!raw || typeof raw !== "object") throw new Error(ASSIGNMENT_HISTORY_ERROR);
      const row = raw as unknown as Record<string, unknown>;
      if (typeof row.id !== "string" || !row.id || !dateOrNull(row.previous_start) || !dateOrNull(row.new_start)
        || typeof row.released_at !== "string" || !Number.isFinite(Date.parse(row.released_at))
        || (hasPay && row.payout_cents !== null && (typeof row.payout_cents !== "number" || !Number.isSafeInteger(row.payout_cents) || row.payout_cents < 0))) {
        throw new Error(ASSIGNMENT_HISTORY_ERROR);
      }
      return { key: `${table}:${row.id}`, kind: table === "crew_lead_releases" ? "crew" : "schedule",
        previousStart: row.previous_start, newStart: row.new_start, releasedAt: row.released_at,
        agreedCents: hasPay && typeof row.payout_cents === "number" ? row.payout_cents : null };
    });
  }));
  return groups.flat().sort((a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt) || b.key.localeCompare(a.key)).slice(0, ASSIGNMENT_HISTORY_LIMIT);
}
