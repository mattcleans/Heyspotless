/**
 * The rooms in a property, as a stable list.
 *
 * Photo evidence is per room — one before and one after — so "which rooms" has
 * to be a single answer both the cleaner's phone and the invoice gate agree on.
 * Derived from the property's counts rather than stored, because the counts are
 * already the thing the price book quotes from: a house that gains a bedroom
 * gains it in one place.
 *
 * KEYS ARE STABLE AND ORDINAL. `bedroom_2` is the second bedroom for ever. They
 * are matched against photos taken weeks earlier, so renaming or reordering
 * them silently orphans evidence.
 */

import type { RoomCounts } from "../pricing/quote";

export interface Room {
  key: string;
  label: string;
}

/**
 * Walk order, chosen to match how a clean actually runs rather than how the
 * price book is laid out — wet rooms first, bedrooms last, so the list on her
 * phone reads like the job.
 */
const ROOM_TYPES: readonly {
  prefix: string;
  label: string;
  countOf: (rooms: RoomCounts) => number;
}[] = [
  { prefix: "kitchen", label: "Kitchen", countOf: (r) => r.kitchens ?? 1 },
  { prefix: "bathroom", label: "Bathroom", countOf: (r) => r.bathrooms },
  { prefix: "half_bath", label: "Half bath", countOf: (r) => r.halfBaths ?? 0 },
  { prefix: "living_room", label: "Living room", countOf: (r) => r.livingRooms ?? 1 },
  { prefix: "bedroom", label: "Bedroom", countOf: (r) => r.bedrooms },
  { prefix: "utility_room", label: "Utility room", countOf: (r) => r.utilityRooms ?? 1 },
];

/**
 * Every room that needs photographing.
 *
 * A count of zero contributes nothing — a flat with no utility room does not
 * get an unphotographable room on the list, and a cleaner who cannot satisfy a
 * requirement is one who cannot close out her day.
 */
export function roomsFor(counts: RoomCounts): Room[] {
  const rooms: Room[] = [];

  for (const type of ROOM_TYPES) {
    const count = Math.max(0, Math.floor(type.countOf(counts)));
    for (let n = 1; n <= count; n++) {
      rooms.push({
        key: `${type.prefix}_${n}`,
        // Unnumbered when there is only one of them: "Kitchen" rather than
        // "Kitchen 1", which reads like there is a second one somewhere.
        label: count === 1 ? type.label : `${type.label} ${n}`,
      });
    }
  }

  return rooms;
}

/** Two per room — one before, one after. */
export const PHOTOS_PER_ROOM = 2;

export function requiredPhotoCount(counts: RoomCounts): number {
  return roomsFor(counts).length * PHOTOS_PER_ROOM;
}
