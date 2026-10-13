import type { RoomCounts } from "@/lib/pricing/quote";
import { photoGaps, type JobPhoto } from "@/lib/service/completion";
import { roomsFor, type Room } from "@/lib/service/rooms";
import type { VisitSummary } from "./progress";

export function trackedRooms(counts: RoomCounts): Room[] {
  const values = [counts.bedrooms, counts.bathrooms, counts.halfBaths ?? 0,
    counts.kitchens ?? 1, counts.livingRooms ?? 1, counts.utilityRooms ?? 1];
  if (values.some(n => !Number.isSafeInteger(n) || n < 0) || values.reduce((s, n) => s + n, 0) > 250) {
    throw new Error("Your home's room details could not be verified. Please contact the office.");
  }
  return roomsFor(counts);
}

export function recordedRooms(counts: RoomCounts, photos: readonly JobPhoto[]) {
  const rooms = trackedRooms(counts);
  const missing = new Set(photoGaps(counts, photos).map(gap => gap.room.key));
  return rooms.map(room => ({ ...room, recorded: !missing.has(room.key) }));
}

export function finishEstimate(visit: VisitSummary, now: Date): "passed" | "upcoming" | null {
  if (visit.stage !== "cleaning" || !visit.expectedFinishAt) return null;
  return visit.expectedFinishAt.getTime() <= now.getTime() ? "passed" : "upcoming";
}
