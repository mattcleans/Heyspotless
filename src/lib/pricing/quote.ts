/**
 * Quote construction. The single path from a property's room counts to a price
 * — the booking widget, the admin estimate builder, and recurring plan
 * generation all call this, so a quote cannot differ depending on where it was
 * created. That divergence is exactly what happened in Housecall Pro, where the
 * Services book and the pricing forms held separate copies of the same rates.
 */

import {
  type Frequency,
  type PriceBookItem,
  type RoomKey,
  type ServiceType,
  findExtra,
  itemsForService,
} from "./price-book";

export interface RoomCounts {
  bedrooms: number;
  bathrooms: number;
  /** A Zillow "2.5 ba" is 2 full baths + 1 half bath — never a fractional bath. */
  halfBaths?: number;
  kitchens?: number;
  livingRooms?: number;
  utilityRooms?: number;
}

export interface ExtraSelection {
  itemKey: string;
  quantity?: number;
}

export interface QuoteLine {
  itemKey: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  cleanMinutes: number;
  isExtra: boolean;
}

export interface Quote {
  service: ServiceType;
  frequency: Frequency;
  lines: QuoteLine[];
  roomsCents: number;
  extrasCents: number;
  totalCents: number;
  estimatedMinutes: number;
}

export class PriceBookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceBookError";
  }
}

/** Room-count key for each price book line. `arrival` is always quantity 1. */
function quantityFor(itemKey: RoomKey, rooms: RoomCounts): number {
  switch (itemKey) {
    case "arrival":
      return 1;
    case "bedroom":
      return rooms.bedrooms;
    case "bathroom":
      return rooms.bathrooms;
    case "half_bath":
      return rooms.halfBaths ?? 0;
    case "kitchen":
      return rooms.kitchens ?? 1;
    case "living":
      return rooms.livingRooms ?? 1;
    case "utility":
      return rooms.utilityRooms ?? 1;
  }
}

function rateFor(item: PriceBookItem, frequency: Frequency): number | undefined {
  return item.rates[frequency];
}

/**
 * Build a quote. Throws rather than returning a zero total when the service is
 * not sold at the requested frequency — Deep is one-time/monthly only and Move
 * In/Out is one-time only, and a silent $0 quote is worse than an error.
 */
export function buildQuote(
  service: ServiceType,
  frequency: Frequency,
  rooms: RoomCounts,
  extras: readonly ExtraSelection[] = [],
): Quote {
  const items = itemsForService(service);
  if (items.length === 0) {
    throw new PriceBookError(`unknown service "${service}"`);
  }
  if (items.every((i) => rateFor(i, frequency) === undefined)) {
    throw new PriceBookError(
      `${service} is not sold at frequency "${frequency}": ` +
        `Deep is one-time/monthly only, Move In/Out is one-time only`,
    );
  }
  if (rooms.bedrooms < 0 || rooms.bathrooms < 0) {
    throw new PriceBookError("room counts cannot be negative");
  }

  const lines: QuoteLine[] = [];

  for (const item of items) {
    const quantity = quantityFor(item.itemKey, rooms);
    if (quantity <= 0) continue;

    const unitPriceCents = rateFor(item, frequency);
    if (unitPriceCents === undefined) {
      throw new PriceBookError(
        `price book has no rate for ${service}/${item.itemKey} at ${frequency}`,
      );
    }

    lines.push({
      itemKey: item.itemKey,
      name: item.name,
      quantity,
      unitPriceCents,
      totalCents: unitPriceCents * quantity,
      cleanMinutes: item.cleanMinutes * quantity,
      isExtra: false,
    });
  }

  for (const selection of extras) {
    const extra = findExtra(selection.itemKey);
    if (!extra) throw new PriceBookError(`unknown extra "${selection.itemKey}"`);
    const quantity = selection.quantity ?? 1;
    if (quantity <= 0) continue;

    lines.push({
      itemKey: extra.itemKey,
      name: extra.name,
      quantity,
      unitPriceCents: extra.priceCents,
      totalCents: extra.priceCents * quantity,
      cleanMinutes: extra.cleanMinutes * quantity,
      isExtra: true,
    });
  }

  const roomsCents = sum(lines.filter((l) => !l.isExtra).map((l) => l.totalCents));
  const extrasCents = sum(lines.filter((l) => l.isExtra).map((l) => l.totalCents));

  return {
    service,
    frequency,
    lines,
    roomsCents,
    extrasCents,
    totalCents: roomsCents + extrasCents,
    estimatedMinutes: sum(lines.map((l) => l.cleanMinutes)),
  };
}

/**
 * Estimated hours for a quote. This is the denominator of every payout
 * decision — see lib/dispatch/ladder.ts, which prices offers in dollars per
 * hour rather than as a percentage of the ticket.
 */
export function estimatedHours(quote: Quote): number {
  return quote.estimatedMinutes / 60;
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
