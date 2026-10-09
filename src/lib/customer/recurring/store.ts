import { SERVICE_TYPES, type ServiceType } from "@/lib/pricing/price-book";
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isChoiceId } from "../cleaner-choice/input";
import {
  calendarDay,
  frequency,
  object,
  toScheduleReceipt,
  type RecurringFrequency,
} from "./types";
export interface ClientSchedule {
  id: string;
  active: boolean;
  customerId: string;
  street: string;
  city: string;
  service: ServiceType;
  frequency: RecurringFrequency;
  anchorDate: string;
  startTime: string;
  pausedUntil: string | null;
  endsOn: string | null;
  priceCents: number;
  horizonDays: number;
  skips: string[];
}
export function toClientSchedule(value: unknown): ClientSchedule {
  const r = object(value),
    h = object(r.properties);
  if (
    typeof r.active !== "boolean" ||
    !isChoiceId(r.id) ||
    !isChoiceId(r.customer_id) ||
    typeof h.street !== "string" ||
    typeof h.city !== "string" ||
    !SERVICE_TYPES.includes(r.service as ServiceType) ||
    !frequency(r.freq) ||
    !calendarDay(r.anchor_date) ||
    typeof r.start_time !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d:00$/.test(r.start_time) ||
    (r.paused_until !== null && !calendarDay(r.paused_until)) ||
    (r.ends_on !== null && !calendarDay(r.ends_on)) ||
    !Number.isSafeInteger(r.agreed_price_cents) ||
    Number(r.agreed_price_cents) < 0 ||
    !Number.isSafeInteger(r.horizon_days) ||
    Number(r.horizon_days) < 7 ||
    Number(r.horizon_days) > 180 ||
    !Array.isArray(r.recurring_plan_skips) ||
    !r.recurring_plan_skips.every((s) => calendarDay(object(s).occurrence_date))
  )
    throw new Error(
      "Your recurring schedule is unavailable. Refresh or call the office.",
    );
  return {
    id: r.id,
    active: r.active,
    customerId: r.customer_id,
    street: h.street,
    city: h.city,
    service: r.service as ServiceType,
    frequency: r.freq,
    anchorDate: r.anchor_date,
    startTime: r.start_time.slice(0, 5),
    pausedUntil: r.paused_until as string | null,
    endsOn: r.ends_on as string | null,
    priceCents: r.agreed_price_cents as number,
    horizonDays: r.horizon_days as number,
    skips: r.recurring_plan_skips.map(
      (s) => object(s).occurrence_date as string,
    ),
  };
}

export async function clientSchedules(db: SupabaseClient, customerId: string) {
  const { data, error } = await db.rpc("read_my_recurring_schedules", {
    p_plan: null,
    p_customer: customerId,
  });
  if (error || !Array.isArray(data))
    throw new Error(
      "Recurring schedules could not be loaded. Refresh or call the office.",
    );
  const rows = data.map(toClientSchedule);
  if (rows.some((row) => row.customerId !== customerId))
    throw new Error("Recurring schedules could not be verified.");
  return rows;
}
export async function clientSchedule(db: SupabaseClient, id: string) {
  const { data, error } = await db.rpc("read_my_recurring_schedules", {
    p_plan: id,
    p_customer: null,
  });
  if (error || !Array.isArray(data) || data.length > 1)
    throw new Error(
      "This recurring schedule could not be loaded. Refresh or call the office.",
    );
  if (data.length === 0) return null;
  const row = toClientSchedule(data[0]);
  if (row.id !== id)
    throw new Error("This recurring schedule could not be verified.");
  return row;
}
export async function scheduleHistory(db: SupabaseClient, id: string) {
  const { data, error } = await db
    .from("recurring_schedule_changes")
    .select("id,review,confirmed_at")
    .eq("plan_id", id)
    .order("generation_epoch", { ascending: false })
    .limit(3);
  if (error || !Array.isArray(data))
    throw new Error(
      "Schedule history could not be loaded. Refresh or call the office.",
    );
  return data.map(toScheduleReceipt);
}
export interface RecurringVisitChange {
  id: string;
  planId: string;
  action: "moved" | "removed" | "added" | "kept";
  previousStart: string | null;
  newStart: string | null;
  priceCents: number | null;
  reason: string;
  savedAt: string;
}
export async function recurringVisitChanges(
  db: SupabaseClient,
  jobId: string,
): Promise<RecurringVisitChange[]> {
  const { data, error } = await db.rpc("read_my_recurring_visit_changes", {
    p_job: jobId,
  });
  if (error && ["42P01", "PGRST205", "PGRST202", "42883"].includes(error.code))
    return [];
  if (error || !Array.isArray(data))
    throw new Error(
      "Recurring appointment history could not be loaded. Refresh or call the office.",
    );
  return data.map((raw) => {
    const r = object(raw),
      parent = object(r.recurring_schedule_changes),
      validTime = (value: unknown) =>
        value === null ||
        (typeof value === "string" && Number.isFinite(Date.parse(value)));
    if (
      !isChoiceId(r.change_id) ||
      !isChoiceId(parent.plan_id) ||
      !["moved", "removed", "added", "kept"].includes(r.action as string) ||
      !validTime(r.previous_start) ||
      !validTime(r.new_start) ||
      (r.new_price_cents !== null &&
        (!Number.isSafeInteger(r.new_price_cents) ||
          Number(r.new_price_cents) < 0)) ||
      typeof r.reason !== "string" ||
      typeof parent.confirmed_at !== "string" ||
      !Number.isFinite(Date.parse(parent.confirmed_at))
    )
      throw new Error("Recurring appointment history could not be verified.");
    return {
      id: r.change_id,
      planId: parent.plan_id,
      action: r.action as RecurringVisitChange["action"],
      previousStart: r.previous_start as string | null,
      newStart: r.new_start as string | null,
      priceCents: r.new_price_cents as number | null,
      reason: r.reason,
      savedAt: parent.confirmed_at,
    };
  });
}
