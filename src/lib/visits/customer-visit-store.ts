import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordedRooms, trackedRooms } from "./customer-visit";
import { visitStage, type VisitSummary } from "./progress";

type Row = Record<string, unknown>;
const failed = () =>
  new Error("Unable to load your visit details. Please refresh and try again.");
const date = (value: unknown): Date | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw failed();
  return new Date(value);
};
const text = (value: unknown): string => {
  if (typeof value !== "string") throw failed();
  return value;
};
const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw failed();
  return value;
};
export interface CustomerVisit {
  summary: VisitSummary;
  address: string;
  propertyId: string;
  cleanerId: string | null;
  cleanerName?: string | null;
  assignmentUnavailable?: boolean;
  backup?: {
    name: string;
    preferredName: string;
    approved: boolean;
    declined: boolean;
  } | null;
  rooms: ReturnType<typeof recordedRooms>;
}

/** Every query uses the signed-in client and existing own-visit RLS. */
export async function loadCustomerVisit(
  db: SupabaseClient,
  id: string,
): Promise<CustomerVisit | null> {
  const result = await db
    .from("jobs")
    .select(
      `id,status,property_id,scheduled_start,started_at,completed_at,estimated_clean_minutes,
    properties(street,city,zip,bedrooms,bathrooms,half_baths,kitchens,living_rooms,utility_rooms)`,
    )
    .eq("id", id)
    .maybeSingle();
  if (result.error) throw failed();
  if (!result.data) return null;
  const row = result.data as Row;
  const property = Array.isArray(row.properties)
    ? row.properties[0]
    : row.properties;
  if (!property || typeof property !== "object") throw failed();
  const home = property as Row;
  const counts = {
    bedrooms: count(home.bedrooms),
    bathrooms: count(home.bathrooms),
    halfBaths: count(home.half_baths),
    kitchens: count(home.kitchens),
    livingRooms: count(home.living_rooms),
    utilityRooms: count(home.utility_rooms),
  };
  const required = trackedRooms(counts);
  const [assigned, photos, backups] = await Promise.all([
    db
      .from("client_visit_assignments")
      .select("cleaner_id,full_name")
      .eq("job_id", id)
      .eq("is_lead", true)
      .order("assigned_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(2),
    required.length
      ? db
          .from("job_photos")
          .select("room_key,kind")
          .eq("job_id", id)
          .in(
            "room_key",
            required.map((room) => room.key),
          )
          .in("kind", ["before", "after"])
          .order("id", { ascending: true })
          .limit(required.length * 2)
      : Promise.resolve({ data: [], error: null }),
    db
      .from("visit_backup_status")
      .select("backup_name,preferred_name,approved,decision_id")
      .eq("job_id", id)
      .limit(2),
  ]);
  const backupUnavailable =
    !!backups.error && ["42P01", "PGRST205"].includes(backups.error.code);
  if (
    (backups.error && !backupUnavailable) ||
    (!backupUnavailable && !Array.isArray(backups.data))
  )
    throw failed();
  const backupRows = backupUnavailable ? [] : backups.data!;
  if (backupRows.length > 1)
    throw new Error(
      "Your cleaner assignment needs review. Please contact the office.",
    );
  const b = backupRows[0];
  if (
    b &&
    (typeof b.approved !== "boolean" ||
      (b.decision_id !== null && typeof b.decision_id !== "string"))
  )
    throw failed();
  const backup = b
    ? {
        name: text(b.backup_name),
        preferredName: text(b.preferred_name),
        approved: b.approved as boolean,
        declined: b.approved === false && b.decision_id !== null,
      }
    : null;
  const assignmentUnavailable =
    !!assigned.error && ["42P01", "PGRST205"].includes(assigned.error.code);
  if (
    (assigned.error && !assignmentUnavailable) ||
    photos.error ||
    (!assignmentUnavailable && !Array.isArray(assigned.data)) ||
    !Array.isArray(photos.data)
  )
    throw failed();
  const leads = assignmentUnavailable ? [] : assigned.data!;
  // Do not arbitrarily name one cleaner when the lead assignment is ambiguous.
  if (leads.length > 1)
    throw new Error(
      "Your cleaner assignment needs review. Please contact the office.",
    );
  const lead = leads[0];
  const cleanerId = lead ? text(lead.cleaner_id) : null;
  const rooms = recordedRooms(
    counts,
    photos.data.map((photo) => ({
      roomKey: text(photo.room_key),
      kind: text(photo.kind),
    })),
  );
  const startedAt = date(row.started_at),
    scheduledStart = date(row.scheduled_start);
  const estimatedMinutes = count(row.estimated_clean_minutes);
  const expectedFinishAt =
    startedAt && estimatedMinutes > 0
      ? new Date(startedAt.getTime() + estimatedMinutes * 60000)
      : null;
  if (expectedFinishAt && !Number.isFinite(expectedFinishAt.getTime()))
    throw failed();
  return {
    propertyId: text(row.property_id),
    address: `${text(home.street)}, ${text(home.city)} ${text(home.zip)}`,
    cleanerId,
    assignmentUnavailable: assignmentUnavailable || backupUnavailable,
    backup,
    cleanerName: lead ? text(lead.full_name) : null,
    rooms,
    summary: {
      stage: visitStage(text(row.status), startedAt, cleanerId !== null),
      scheduledStart,
      startedAt,
      completedAt: date(row.completed_at),
      expectedFinishAt,
      roomsDone: rooms.filter((room) => room.recorded).length,
      roomsTotal: rooms.length,
    },
  };
}
