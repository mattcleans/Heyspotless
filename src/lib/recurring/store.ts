import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { toCalendarDate, type CalendarDate } from "../time/zone";
import type { Frequency } from "../pricing/price-book";
import type { RecurringPlan } from "./schedule";

/**
 * Reading and materialising recurring plans.
 *
 * Same division as everywhere else in this codebase: `schedule.ts` decides
 * which dates a plan calls for, purely and without a database; this executes
 * that decision. Nothing here works out when a visit should happen.
 *
 * Takes the service-role client, because the generator runs on a schedule
 * with no signed-in user — the same posture as the auto-charge sweep.
 */
export class RecurringStore {
  constructor(private readonly db: SupabaseClient) {}

  /**
   * Every active plan, with its skips, in the shape the engine expects.
   *
   * Skips are fetched alongside rather than per-plan: the sweep runs over the
   * whole book, and one query beats N.
   */
  async listActivePlans(limit = 500): Promise<RecurringPlan[]> {
    const { data, error } = await this.db
      .from("recurring_plans")
      .select(
        `id, customer_id, property_id, freq, anchor_date, start_time,
         ends_on, paused_until, active, horizon_days`,
      )
      .eq("active", true)
      .limit(limit);
    if (error) throw new Error(`listActivePlans: ${error.message}`);

    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    if (rows.length === 0) return [];

    const planIds = rows.map((r) => String(r["id"]));
    const skipsByPlan = await this.skipsFor(planIds);

    return rows.map((row) => toPlan(row, skipsByPlan.get(String(row["id"])) ?? []));
  }

  /** How far ahead each plan materialises. Per-plan, defaulted in the schema. */
  async horizonFor(planId: string): Promise<number> {
    const { data, error } = await this.db
      .from("recurring_plans")
      .select("horizon_days")
      .eq("id", planId)
      .maybeSingle();
    if (error) throw new Error(`horizonFor: ${error.message}`);
    const days = (data as Record<string, unknown> | null)?.["horizon_days"];
    return typeof days === "number" ? days : 42;
  }

  private async skipsFor(planIds: readonly string[]): Promise<Map<string, CalendarDate[]>> {
    const { data, error } = await this.db
      .from("recurring_plan_skips")
      .select("plan_id, occurrence_date")
      .in("plan_id", [...planIds]);
    if (error) throw new Error(`skipsFor: ${error.message}`);

    const byPlan = new Map<string, CalendarDate[]>();
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const planId = row["plan_id"];
      const date = toCalendarDate(row["occurrence_date"]);
      if (typeof planId !== "string" || !date) continue;
      const existing = byPlan.get(planId);
      if (existing) existing.push(date);
      else byPlan.set(planId, [date]);
    }
    return byPlan;
  }

  /**
   * Create the job for one occurrence, or return the one already there.
   *
   * Idempotent in the database, not here: `materialise_recurring_job` is
   * guarded by a unique index on (plan, occurrence date), so two sweeps
   * racing on the same visit produce one job. Null means the occurrence is
   * skipped and no visit should exist.
   */
  async materialise(
    planId: string,
    occurrenceDate: CalendarDate,
    startsAt: Date,
  ): Promise<string | null> {
    const { data, error } = await this.db.rpc("materialise_recurring_job", {
      p_plan_id: planId,
      p_occurrence_date: occurrenceDate,
      p_scheduled_start: startsAt.toISOString(),
    });
    if (error) throw new Error(`materialise: ${error.message}`);
    return typeof data === "string" ? data : null;
  }

  /** Call off one visit. The skip is a row; the job is cancelled, not deleted. */
  async skip(
    planId: string,
    occurrenceDate: CalendarDate,
    reason: string | null,
    createdBy: string | null,
  ): Promise<void> {
    const { error } = await this.db.rpc("skip_recurring_occurrence", {
      p_plan_id: planId,
      p_occurrence_date: occurrenceDate,
      p_reason: reason,
      p_created_by: createdBy,
    });
    if (error) throw new Error(`skip: ${error.message}`);
  }

  /** Put a called-off visit back in play. The next sweep re-creates the job. */
  async unskip(planId: string, occurrenceDate: CalendarDate): Promise<boolean> {
    const { data, error } = await this.db.rpc("unskip_recurring_occurrence", {
      p_plan_id: planId,
      p_occurrence_date: occurrenceDate,
    });
    if (error) throw new Error(`unskip: ${error.message}`);
    return data === true;
  }
}

function toPlan(row: Record<string, unknown>, skips: CalendarDate[]): RecurringPlan {
  const anchor = toCalendarDate(row["anchor_date"]);
  if (!anchor) {
    // 0014 constrains an active plan to have one, so this is a corrupted row
    // rather than a state the schedule should try to guess at.
    throw new Error(`recurring plan ${String(row["id"])} is active with no anchor date`);
  }

  return {
    id: String(row["id"]),
    customerId: String(row["customer_id"]),
    propertyId: String(row["property_id"]),
    frequency: String(row["freq"]) as Frequency,
    anchorDate: anchor,
    // Postgres `time` arrives as HH:MM:SS; the engine wants the wall clock.
    startTime: String(row["start_time"] ?? "09:00").slice(0, 5),
    endsOn: toCalendarDate(row["ends_on"]),
    pausedUntil: toCalendarDate(row["paused_until"]),
    active: row["active"] === true,
    horizonDays: typeof row["horizon_days"] === "number" ? row["horizon_days"] : 42,
    skips,
  };
}
