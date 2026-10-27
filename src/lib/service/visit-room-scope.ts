import type { RoomCounts } from "@/lib/pricing/quote";

export interface VisitRoomScope {
  jobId: string;
  customerId: string;
  propertyId: string;
  rooms: RoomCounts;
  source: "client_booking" | "client_quote" | "plan_created" | "visit_created" | "legacy_home";
  capturedAt: Date;
}
export const VISIT_ROOM_SCOPE_SELECT = "job_id,customer_id,property_id,bedrooms,bathrooms,half_baths,kitchens,living_rooms,utility_rooms,source,captured_at";
const fields = { bedrooms: "bedrooms", bathrooms: "bathrooms", halfBaths: "half_baths", kitchens: "kitchens", livingRooms: "living_rooms", utilityRooms: "utility_rooms" } as const;
export function validVisitRoomCounts(value: unknown): value is RoomCounts {
  if (!value || typeof value !== "object") return false;
  const counts = value as RoomCounts;
  const values = Object.keys(fields).map(key => counts[key as keyof typeof fields]);
  return values.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 250) && values.reduce<number>((sum, value) => sum + (value ?? 0), 0) <= 250;
}

/** Missing or mismatched scope is unknown, never a zero-room requirement. */
export function readVisitRoomScope(value: unknown, identity: { id: string; customerId: string; propertyId: string }): VisitRoomScope | null {
  if (Array.isArray(value) && value.length !== 1) return null;
  const row = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || row.job_id !== identity.id || row.customer_id !== identity.customerId || row.property_id !== identity.propertyId) return null;
  const rooms = Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, row[column]])) as unknown as RoomCounts;
  if (!validVisitRoomCounts(rooms) || !["client_booking", "client_quote", "plan_created", "visit_created", "legacy_home"].includes(String(row.source)) || typeof row.captured_at !== "string" || !Number.isFinite(Date.parse(row.captured_at))) return null;
  return { jobId: identity.id, customerId: identity.customerId, propertyId: identity.propertyId, rooms, source: row.source as VisitRoomScope["source"], capturedAt: new Date(row.captured_at) };
}

export function roomsForVisit(job: { id: string; customerId: string; propertyId: string; roomScope?: VisitRoomScope | null }, demoRooms?: RoomCounts): RoomCounts | null {
  const scope = job.roomScope;
  if (scope && scope.jobId === job.id && scope.customerId === job.customerId && scope.propertyId === job.propertyId && validVisitRoomCounts(scope.rooms)) return scope.rooms;
  // The caller must explicitly supply sample-home counts for a sample visit.
  if (demoRooms) {
    const counts = { halfBaths: 0, kitchens: 1, livingRooms: 1, utilityRooms: 1, ...demoRooms };
    if (validVisitRoomCounts(counts)) return counts;
  }
  return null;
}

export function formatVisitRoomCounts(counts: RoomCounts): string {
  if (!validVisitRoomCounts(counts)) return "Room list unavailable";
  return [[counts.bedrooms,"bedroom"],[counts.bathrooms,"full bath"],[counts.halfBaths,"half bath"],[counts.kitchens,"kitchen"],[counts.livingRooms,"living room"],[counts.utilityRooms,"utility room"]].map(([n,label])=>`${n} ${label}${n===1?"":"s"}`).join(", ");
}
