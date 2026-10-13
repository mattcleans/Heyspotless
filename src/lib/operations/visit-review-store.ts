import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toJob } from "@/lib/data/mappers";
import type { RoomCounts } from "@/lib/pricing/quote";
import { REVIEW_LIMIT, reviewRooms, type ReviewVisit, type VisitFacts, type ReviewPhoto } from "./visit-review";

type Row = Record<string, unknown>;
const text = (row: Row, key: string): string => {
  if (typeof row[key] !== "string") throw new Error("Visit review contains incomplete records. Please refresh.");
  return row[key];
};
const money = (row: Row, key: string): number => {
  const value = row[key];
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.trim() === "") || !Number.isSafeInteger(Number(value))) throw new Error("Visit invoice amounts could not be verified.");
  return Number(value);
};
const date = (value: unknown): Date | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Visit timing could not be verified.");
  return new Date(value);
};
function rows(data: unknown, error: unknown): Row[] {
  if (error || !Array.isArray(data)) throw new Error("Unable to load visit review. Please refresh and try again.");
  return data as Row[];
}
function relation(value: unknown): Row {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") throw new Error("Assigned cleaner details are unavailable. Please refresh.");
  return row as Row;
}
export async function listUninvoicedVisits(db: SupabaseClient): Promise<ReviewVisit[]> {
  const { data, error } = await db.from("jobs").select(`id, customer_id, property_id, status, service, freq,
    scheduled_start, completed_at, price_cents, estimated_clean_minutes,
    customers(first_name,last_name), properties(street,city,zip,bedrooms,bathrooms)`)
    .eq("status", "complete").is("invoiced_at", null)
    .order("completed_at", { ascending: true, nullsFirst: true }).order("id", { ascending: true }).limit(REVIEW_LIMIT);
  return rows(data, error).map(row => ({ job: toJob(row), completedAt: date(row.completed_at) }));
}

/** Caller supplies the request-scoped client after checking the admin profile. */
export async function loadVisitFacts(db: SupabaseClient, jobId: string, counts: RoomCounts): Promise<VisitFacts> {
  if (!jobId) throw new Error("Visit identity is required.");
  const keys = reviewRooms(counts).map(room => room.key);
  // Required photos are unique per room and kind. Restrict to those keys so
  // arbitrary extra records cannot crowd required evidence out of a read.
  const [timing, photos, issues, assignments, invoices] = await Promise.all([
    db.from("jobs").select("started_at,completed_at,invoiced_at").eq("id", jobId).maybeSingle(),
    keys.length ? db.from("job_photos").select("id,room_key,kind,taken_at").eq("job_id", jobId)
      .in("kind", ["before", "after"]).in("room_key", keys).order("id", { ascending: true }).limit(keys.length * 2)
      : Promise.resolve({ data: [], error: null }),
    db.from("job_photos").select("id,room_key,kind,taken_at").eq("job_id", jobId).eq("kind", "issue")
      .order("taken_at", { ascending: false }).order("id", { ascending: false }).limit(20),
    db.from("job_assignments").select("cleaner_id,cleaners(id,full_name,profiles(phone))").eq("job_id", jobId)
      .order("id", { ascending: true }).limit(50),
    db.from("invoices").select("id,status,total_cents,balance_cents").eq("job_id", jobId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(200),
  ]);
  if (timing.error || !timing.data) throw new Error("Visit timing is unavailable. Please refresh.");
  const photo = (row: Row): ReviewPhoto => ({ id: text(row, "id"), roomKey: typeof row.room_key === "string" ? row.room_key : null,
    kind: text(row, "kind"), takenAt: date(row.taken_at) ?? (() => { throw new Error("Photo time is unavailable."); })() });
  return {
    startedAt: date(timing.data.started_at), completedAt: date(timing.data.completed_at), invoicedAt: date(timing.data.invoiced_at),
    photos: rows(photos.data, photos.error).map(photo), issues: rows(issues.data, issues.error).map(photo),
    assignments: rows(assignments.data, assignments.error).map(row => {
      const cleaner = relation(row.cleaners);
      const profile = cleaner.profiles ? relation(cleaner.profiles) : null;
      return { id: text(cleaner, "id"), name: text(cleaner, "full_name"), phone: typeof profile?.phone === "string" ? profile.phone : null };
    }),
    invoices: rows(invoices.data, invoices.error).map(row => ({ id: text(row, "id"), status: text(row, "status"),
      totalCents: money(row, "total_cents"), balanceCents: money(row, "balance_cents") })),
  };
}
