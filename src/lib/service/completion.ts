/**
 * Whether a job is finished, and whether it may be invoiced.
 *
 * Two different questions, deliberately. A cleaner taps done and the job is
 * COMPLETE — she has left, the customer's house is clean, and nothing should
 * block her closing out her day. Whether we may BILL for it is a separate test
 * that the evidence supports it, and it can be satisfied later: photos upload
 * late from a house with no signal, or drain out of the offline queue
 * afterwards.
 *
 * So the invoice gate is evaluated on both events — the job completing, and a
 * photo arriving — whichever of them completes the pair. Checking only at
 * completion would leave every job with a slow upload permanently uninvoiced.
 */

import { roomsFor, type Room } from "./rooms";
import type { RoomCounts } from "../pricing/quote";

export type PhotoKind = "before" | "after" | "issue";

export interface JobPhoto {
  roomKey: string | null;
  kind: string;
}

export interface RoomGap {
  room: Room;
  missing: PhotoKind[];
}

/**
 * What is still outstanding before this job can be billed.
 *
 * Returns the rooms with something missing, in walk order, so the answer can go
 * straight onto a cleaner's screen as a list of what is left rather than a
 * count she has to work out.
 */
export function photoGaps(counts: RoomCounts, photos: readonly JobPhoto[]): RoomGap[] {
  const taken = new Map<string, Set<string>>();
  for (const photo of photos) {
    if (!photo.roomKey) continue;
    const kinds = taken.get(photo.roomKey) ?? new Set<string>();
    kinds.add(photo.kind);
    taken.set(photo.roomKey, kinds);
  }

  const gaps: RoomGap[] = [];
  for (const room of roomsFor(counts)) {
    const kinds = taken.get(room.key) ?? new Set<string>();
    const missing: PhotoKind[] = [];
    // `issue` photos are extra evidence, never a substitute: a picture of a
    // stain is not a picture of a clean room.
    if (!kinds.has("before")) missing.push("before");
    if (!kinds.has("after")) missing.push("after");
    if (missing.length > 0) gaps.push({ room, missing });
  }
  return gaps;
}

export function photoRequirementMet(
  counts: RoomCounts,
  photos: readonly JobPhoto[],
): boolean {
  return photoGaps(counts, photos).length === 0;
}

export type InvoiceReadiness =
  | { ready: true }
  | { ready: false; reason: "not_complete" }
  | { ready: false; reason: "photos_outstanding"; gaps: RoomGap[] };

/**
 * May this job be invoiced?
 *
 * "Complete but uninvoiced" is a real and useful state rather than a bug: a
 * clean finished three days ago with no photos is either a cleaner who needs a
 * nudge or revenue quietly going uncollected, and both want a person to see
 * them. The gaps come back with the answer so that person is told which rooms
 * rather than just that something is missing.
 */
export function invoiceReadiness(
  status: string,
  counts: RoomCounts,
  photos: readonly JobPhoto[],
): InvoiceReadiness {
  if (status !== "complete") return { ready: false, reason: "not_complete" };

  const gaps = photoGaps(counts, photos);
  if (gaps.length > 0) return { ready: false, reason: "photos_outstanding", gaps };
  return { ready: true };
}
