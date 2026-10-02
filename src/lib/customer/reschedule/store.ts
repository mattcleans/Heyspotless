import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toRescheduleReceipt } from "./types";
export async function loadRescheduleVisit(db: SupabaseClient, id: string) {
  const { data, error } = await db
    .from("jobs")
    .select("status,started_at,recurring_plan_id,occurrence_date")
    .eq("id", id)
    .maybeSingle();
  if (error || !data || typeof data.status !== "string")
    throw new Error(
      "Appointment details are unavailable. Refresh or call the office.",
    );
  return {
    closed:
      !["unscheduled", "scheduled", "dispatching", "assigned"].includes(
        data.status,
      ) || data.started_at !== null,
    recurring: data.recurring_plan_id !== null && data.occurrence_date !== null,
  };
}
export async function rescheduleHistory(db: SupabaseClient, id: string) {
  const { data, error } = await db
    .from("visit_reschedules")
    .select(
      "id,job_id,previous_start,new_start,new_end,price_cents,fee_cents,released_count,confirmed_at,invoice_id",
    )
    .eq("job_id", id)
    .order("version", { ascending: false })
    .limit(5);
  if (error || !Array.isArray(data))
    throw new Error(
      "Appointment change history is unavailable. Refresh or call the office.",
    );
  return data.map(toRescheduleReceipt);
}
export interface ReleasedVisit {
  id: string;
  previousStart: string | null;
  newStart: string;
  releasedAt: string;
}
export async function releasedVisits(
  db: SupabaseClient,
  cleanerId: string,
): Promise<ReleasedVisit[]> {
  const { data, error } = await db
    .from("visit_reschedule_releases")
    .select("id,previous_start,new_start,released_at")
    .eq("cleaner_id", cleanerId)
    .gte(
      "released_at",
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    )
    .order("released_at", { ascending: false })
    .limit(10);
  if (error && ["42P01", "PGRST205"].includes(error.code)) return [];
  if (error || !Array.isArray(data))
    throw new Error(
      "Schedule changes are unavailable. Refresh before heading to a visit.",
    );
  return data.map((row) => {
    if (
      typeof row.id !== "string" ||
      typeof row.new_start !== "string" ||
      !Number.isFinite(Date.parse(row.new_start)) ||
      (row.previous_start !== null &&
        (typeof row.previous_start !== "string" ||
          !Number.isFinite(Date.parse(row.previous_start))))
    )
      throw new Error(
        "Schedule changes are unavailable. Refresh before heading to a visit.",
      );
    return {
      id: row.id,
      previousStart: row.previous_start,
      newStart: row.new_start,
      releasedAt: row.released_at,
    };
  });
}
