/**
 * The Hey Spotless price book, effective 9 August 2026.
 *
 * This is the TypeScript mirror of supabase/migrations/0002_price_book.sql and
 * MUST stay in lockstep with it — `npm test` and scripts/verify-migrations.sh
 * assert both against the same published totals, so a drift between them turns
 * one of the two suites red.
 *
 * Two rules carried over from the pricelist itself:
 *
 *  1. The recurring discount is ALREADY BAKED INTO the monthly/biweekly/weekly
 *     columns. Never apply a frequency multiplier on top of these — that is a
 *     double discount. A multiplier could not reproduce these rates anyway:
 *     Standard Bedroom goes $20 -> $17 bi-weekly (0.85 exactly) but Half Bath
 *     goes $11 -> $10 (0.91), because whole-dollar rounding had nowhere else to
 *     land.
 *
 *  2. Extras are flat, never discounted, and were not part of the August 2026
 *     increase.
 */

export const SERVICE_TYPES = ["standard", "deep", "move_in_out"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const FREQUENCIES = ["one_time", "monthly", "biweekly", "weekly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const ROOM_KEYS = [
  "arrival",
  "bedroom",
  "bathroom",
  "half_bath",
  "kitchen",
  "living",
  "utility",
] as const;
export type RoomKey = (typeof ROOM_KEYS)[number];

export interface PriceBookItem {
  readonly service: ServiceType;
  readonly itemKey: RoomKey;
  readonly name: string;
  /** `arrival` is charged once per job; `room` items take a quantity. */
  readonly category: "arrival" | "room";
  /**
   * Duration ESTIMATE, not a measurement. Chosen so a 2bd/2ba standard lands at
   * 2.30h and a 3bd/2ba at 2.55h, bracketing Shonda's stated 2.5h average.
   * The app recalibrates these from `time_entries` as real jobs complete.
   *
   * This matters more than it looks: payout is computed from estimated hours,
   * so underestimating means underpaid offers that never fill, and
   * overestimating means overpaying on every single job.
   */
  readonly cleanMinutes: number;
  /** Rates in cents. A missing frequency means the service is not sold that way. */
  readonly rates: Partial<Record<Frequency, number>>;
  readonly sortOrder: number;
}

export interface PriceBookExtra {
  readonly itemKey: string;
  readonly name: string;
  readonly priceCents: number;
  readonly unitLabel: "flat" | "per load" | "per hour" | "each";
  readonly cleanMinutes: number;
  readonly sortOrder: number;
}

export const PRICE_BOOK: readonly PriceBookItem[] = [
  // ---------------------------------------------------------- standard ----
  { service: "standard", itemKey: "arrival",   name: "Arrival (base)",                   category: "arrival", cleanMinutes: 20, sortOrder: 1, rates: { one_time: 6700, monthly: 6000, biweekly: 5700, weekly: 5400 } },
  { service: "standard", itemKey: "bedroom",   name: "Bedroom",                          category: "room",    cleanMinutes: 15, sortOrder: 2, rates: { one_time: 2000, monthly: 1800, biweekly: 1700, weekly: 1600 } },
  { service: "standard", itemKey: "bathroom",  name: "Bathroom",                         category: "room",    cleanMinutes: 20, sortOrder: 3, rates: { one_time: 2200, monthly: 2000, biweekly: 1900, weekly: 1800 } },
  { service: "standard", itemKey: "half_bath", name: "Half Bathroom",                    category: "room",    cleanMinutes: 10, sortOrder: 4, rates: { one_time: 1100, monthly: 1000, biweekly: 1000, weekly:  900 } },
  { service: "standard", itemKey: "kitchen",   name: "Kitchen",                          category: "room",    cleanMinutes: 25, sortOrder: 5, rates: { one_time: 2000, monthly: 1800, biweekly: 1700, weekly: 1600 } },
  { service: "standard", itemKey: "living",    name: "Living / Dining / Media / Office", category: "room",    cleanMinutes: 15, sortOrder: 6, rates: { one_time: 1700, monthly: 1500, biweekly: 1400, weekly: 1300 } },
  { service: "standard", itemKey: "utility",   name: "Utility Room",                     category: "room",    cleanMinutes:  8, sortOrder: 7, rates: { one_time: 1100, monthly: 1000, biweekly: 1000, weekly:  900 } },

  // -------------------------------------------- deep (one-time + monthly) --
  { service: "deep", itemKey: "arrival",   name: "Arrival",                          category: "arrival", cleanMinutes: 45, sortOrder: 1, rates: { one_time: 10100, monthly: 9100 } },
  { service: "deep", itemKey: "bedroom",   name: "Bedroom",                          category: "room",    cleanMinutes: 27, sortOrder: 2, rates: { one_time:  3400, monthly: 3000 } },
  { service: "deep", itemKey: "bathroom",  name: "Bathroom",                         category: "room",    cleanMinutes: 36, sortOrder: 3, rates: { one_time:  3600, monthly: 3300 } },
  { service: "deep", itemKey: "half_bath", name: "Half Bathroom",                    category: "room",    cleanMinutes: 18, sortOrder: 4, rates: { one_time:  1900, monthly: 1700 } },
  { service: "deep", itemKey: "kitchen",   name: "Kitchen",                          category: "room",    cleanMinutes: 50, sortOrder: 5, rates: { one_time:  4500, monthly: 4100 } },
  { service: "deep", itemKey: "living",    name: "Living / Dining / Media / Office", category: "room",    cleanMinutes: 27, sortOrder: 6, rates: { one_time:  2500, monthly: 2300 } },
  { service: "deep", itemKey: "utility",   name: "Utility Room",                     category: "room",    cleanMinutes: 14, sortOrder: 7, rates: { one_time:  1700, monthly: 1500 } },

  // ------------------------------------------------ move in/out (one-time) --
  { service: "move_in_out", itemKey: "arrival",   name: "Arrival",                          category: "arrival", cleanMinutes: 60, sortOrder: 1, rates: { one_time: 13400 } },
  { service: "move_in_out", itemKey: "bedroom",   name: "Bedroom",                          category: "room",    cleanMinutes: 33, sortOrder: 2, rates: { one_time:  3900 } },
  { service: "move_in_out", itemKey: "bathroom",  name: "Bathroom",                         category: "room",    cleanMinutes: 45, sortOrder: 3, rates: { one_time:  4500 } },
  { service: "move_in_out", itemKey: "half_bath", name: "Half Bathroom",                    category: "room",    cleanMinutes: 22, sortOrder: 4, rates: { one_time:  2800 } },
  { service: "move_in_out", itemKey: "kitchen",   name: "Kitchen",                          category: "room",    cleanMinutes: 60, sortOrder: 5, rates: { one_time:  5000 } },
  { service: "move_in_out", itemKey: "living",    name: "Living / Dining / Media / Office", category: "room",    cleanMinutes: 33, sortOrder: 6, rates: { one_time:  3400 } },
  { service: "move_in_out", itemKey: "utility",   name: "Utility Room",                     category: "room",    cleanMinutes: 18, sortOrder: 7, rates: { one_time:  2200 } },
];

/** Flat, never discounted, unchanged by the August 2026 increase. */
export const PRICE_BOOK_EXTRAS: readonly PriceBookExtra[] = [
  { itemKey: "pet_hair",         name: "Pet Hair / Excessive Pet Hair", priceCents: 5000, unitLabel: "flat",     cleanMinutes: 30, sortOrder: 1 },
  { itemKey: "cabinets",         name: "Inside Cabinets",               priceCents: 5000, unitLabel: "flat",     cleanMinutes: 35, sortOrder: 2 },
  { itemKey: "oven",             name: "Oven Clean",                    priceCents: 5000, unitLabel: "flat",     cleanMinutes: 30, sortOrder: 3 },
  { itemKey: "refrigerator",     name: "Refrigerator Clean",            priceCents: 2500, unitLabel: "flat",     cleanMinutes: 20, sortOrder: 4 },
  { itemKey: "walls",            name: "Walls",                         priceCents: 2500, unitLabel: "flat",     cleanMinutes: 20, sortOrder: 5 },
  { itemKey: "laundry",          name: "Laundry Service / Load",        priceCents: 2000, unitLabel: "per load", cleanMinutes: 15, sortOrder: 6 },
  { itemKey: "baseboards",       name: "Baseboards",                    priceCents: 5000, unitLabel: "flat",     cleanMinutes: 30, sortOrder: 7 },
  { itemKey: "airbnb_laundry",   name: "Airbnb Laundry",                priceCents: 2500, unitLabel: "flat",     cleanMinutes: 20, sortOrder: 8 },
  { itemKey: "feather_laundry",  name: "Feather Laundry",               priceCents:  299, unitLabel: "each",     cleanMinutes:  5, sortOrder: 9 },
  { itemKey: "organization",     name: "Organization Service",          priceCents: 4000, unitLabel: "per hour", cleanMinutes: 60, sortOrder: 10 },
];

export const SERVICE_LABELS: Record<ServiceType, string> = {
  standard: "Standard Clean",
  deep: "Deep Clean",
  move_in_out: "Move In / Out",
};

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  one_time: "One-time",
  monthly: "Monthly",
  biweekly: "Bi-weekly",
  weekly: "Weekly",
};

export function itemsForService(service: ServiceType): readonly PriceBookItem[] {
  return PRICE_BOOK.filter((i) => i.service === service).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Which frequencies this service is actually sold at. */
export function frequenciesForService(service: ServiceType): readonly Frequency[] {
  const arrival = PRICE_BOOK.find((i) => i.service === service && i.itemKey === "arrival");
  if (!arrival) return [];
  return FREQUENCIES.filter((f) => arrival.rates[f] !== undefined);
}

export function findExtra(itemKey: string): PriceBookExtra | undefined {
  return PRICE_BOOK_EXTRAS.find((e) => e.itemKey === itemKey);
}
