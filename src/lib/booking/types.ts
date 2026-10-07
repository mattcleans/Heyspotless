import {
  SERVICE_TYPES,
  FREQUENCIES,
  frequenciesForService,
  type ServiceType,
  type Frequency,
} from "@/lib/pricing/price-book";
import { quoteId, toPricedTerms, type ClientQuote } from "@/lib/quotes/types";
import { zonedTimeToUtc } from "@/lib/time/zone";

export const BOOKING_STATES = ["review", "expired", "stale", "requested", "canceled", "unavailable"] as const;
export type BookingReview = Pick<ClientQuote, "id" | "propertyId" | "service" | "frequency" | "repeats" | "note" | "expiresAt" | "lines" | "totalCents" | "estimatedMinutes" | "home" | "jobId" | "planId"> & {
  requestedStart: string;
  state: (typeof BOOKING_STATES)[number];
};
export type BookingAction =
  | { action: "confirm"; id: string }
  | { action: "review"; id: string; propertyId: string; service: ServiceType; frequency: Frequency;
      start: string; repeats: boolean; extras: { itemKey: string; quantity: number }[]; note: string };
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Check booking details");
  return v as Record<string, unknown>;
}
function text(v: unknown): string {
  if (typeof v !== "string") throw new Error("Check booking details");
  return v;
}
function instant(v: unknown): string {
  const s = text(v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s) || !Number.isFinite(Date.parse(s)))
    throw new Error("Check appointment time");
  return s;
}
function cadence(r: Record<string, unknown>) {
  if (!SERVICE_TYPES.includes(r.service as ServiceType) || !FREQUENCIES.includes(r.frequency as Frequency)
    || !frequenciesForService(r.service as ServiceType).includes(r.frequency as Frequency)
    || typeof r.repeats !== "boolean" || (r.repeats && r.frequency === "one_time"))
    throw new Error("Check service and repeating choice");
  return { service: r.service as ServiceType, frequency: r.frequency as Frequency, repeats: r.repeats };
}
export function parseBookingAction(v: unknown): BookingAction {
  const r = object(v), id = quoteId(r.id);
  const fields = r.action === "confirm" ? ["action", "id"]
    : ["action", "id", "propertyId", "service", "frequency", "start", "repeats", "extras", "note"];
  if (Object.keys(r).sort().join(",") !== fields.sort().join(",")) throw new Error("Unexpected fields");
  if (r.action === "confirm") return { action: "confirm", id };
  if (r.action !== "review" || !Array.isArray(r.extras) || r.extras.length > 30 || text(r.note).length > 1500)
    throw new Error("Check booking details");
  const date = zonedTimeToUtc(text(r.start));
  if (!date.ok) throw new Error("Choose a valid Dallas time");
  if (r.repeats !== (r.frequency !== "one_time")) throw new Error("Choose a repeating schedule for the recurring rate");
  const seen = new Set<string>();
  const extras = r.extras.map(value => {
    const e = object(value), itemKey = text(e.itemKey);
    if (Object.keys(e).sort().join(",") !== "itemKey,quantity" || !itemKey || itemKey.length > 80
      || !Number.isSafeInteger(e.quantity) || Number(e.quantity) < 1 || Number(e.quantity) > 20 || seen.has(itemKey))
      throw new Error("Check extras");
    seen.add(itemKey);
    return { itemKey, quantity: Number(e.quantity) };
  });
  return { action: "review", id, propertyId: quoteId(r.propertyId), ...cadence(r), start: date.date.toISOString(), extras, note: text(r.note).trim() };
}
export function toBookingReview(v: unknown): BookingReview {
  const r = object(v), home = object(r.home);
  if (!BOOKING_STATES.includes(r.state as BookingReview["state"])) throw new Error("Booking outcome unavailable");
  const jobId = r.jobId === null ? null : quoteId(r.jobId), planId = r.planId === null ? null : quoteId(r.planId);
  const state = r.state as BookingReview["state"];
  const terms = cadence(r);
  if ((["requested", "canceled"].includes(state) !== (jobId !== null)) || (planId && (!terms.repeats || !jobId)))
    throw new Error("Booking outcome unavailable");
  return { id: quoteId(r.id), propertyId: quoteId(r.propertyId), ...terms, ...toPricedTerms(r),
    requestedStart: instant(r.requestedStart), expiresAt: instant(r.expiresAt), note: text(r.note), state, jobId, planId,
    home: { street: text(home.street), city: text(home.city), state: text(home.state), zip: text(home.zip) } };
}
export function bookingReviewMatches(action: BookingAction, review: BookingReview): boolean {
  if (review.id !== action.id) return false;
  if (action.action === "confirm") return ["requested", "canceled", "unavailable"].includes(review.state);
  const extras = review.lines.filter(l => l.isExtra);
  return review.propertyId === action.propertyId && review.service === action.service && review.frequency === action.frequency
    && review.repeats === action.repeats && review.note === action.note
    && Date.parse(review.requestedStart) === Date.parse(action.start)
    && extras.length === action.extras.length && action.extras.every(e => extras.some(l => l.itemKey === e.itemKey && l.quantity === e.quantity));
}
