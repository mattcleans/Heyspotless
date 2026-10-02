import { isChoiceId } from "../cleaner-choice/input";
import { zonedTimeToUtc } from "@/lib/time/zone";
export interface RescheduleDetails {
  id: string;
  jobId: string;
  previousStart: string | null;
  newStart: string;
  newEnd: string;
  priceCents: number;
  feeCents: 0 | 6000;
  releasedCount: number;
}
export interface RescheduleQuote extends RescheduleDetails {
  expiresAt: string;
}
export interface RescheduleReceipt extends RescheduleDetails {
  confirmedAt: string;
  invoiceId: string | null;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Review the new appointment time.");
  return value as Record<string, unknown>;
}
const date = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
const cents = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function common(value: unknown): RescheduleDetails {
  const r = record(value);
  if (
    !isChoiceId(r.id) ||
    !isChoiceId(r.job_id) ||
    (r.previous_start !== null && !date(r.previous_start)) ||
    !date(r.new_start) ||
    !date(r.new_end) ||
    Date.parse(r.new_end) <= Date.parse(r.new_start) ||
    !cents(r.price_cents) ||
    (r.fee_cents !== 0 && r.fee_cents !== 6000) ||
    !cents(r.released_count)
  )
    throw new Error("The new appointment could not be confirmed.");
  return {
    id: r.id,
    jobId: r.job_id,
    previousStart: r.previous_start as string | null,
    newStart: r.new_start,
    newEnd: r.new_end,
    priceCents: r.price_cents,
    feeCents: r.fee_cents,
    releasedCount: r.released_count,
  };
}
export function toRescheduleQuote(value: unknown): RescheduleQuote {
  const r = record(value),
    base = common(r);
  if (!date(r.expires_at)) throw new Error("Review the new time again.");
  return { ...base, expiresAt: r.expires_at };
}
export function toRescheduleReceipt(value: unknown): RescheduleReceipt {
  const r = record(value),
    base = common(r);
  if (!date(r.confirmed_at))
    throw new Error("The saved appointment could not be confirmed.");
  const invoiceId = r.invoice_id ?? null;
  if (invoiceId !== null && !isChoiceId(invoiceId))
    throw new Error("The rescheduling fee invoice could not be confirmed.");
  if (
    (base.feeCents === 6000 && !isChoiceId(invoiceId)) ||
    (base.feeCents === 0 && invoiceId !== null)
  )
    throw new Error("The rescheduling fee invoice could not be confirmed.");
  return { ...base, confirmedAt: r.confirmed_at, invoiceId };
}
export function checkedReschedule(
  value: unknown,
  receipt: false,
): RescheduleQuote;
export function checkedReschedule(
  value: unknown,
  receipt: true,
): RescheduleReceipt;
export function checkedReschedule(value: unknown, receipt: boolean) {
  const r = record(value),
    raw = {
      id: r.id,
      job_id: r.jobId,
      previous_start: r.previousStart,
      new_start: r.newStart,
      new_end: r.newEnd,
      price_cents: r.priceCents,
      fee_cents: r.feeCents,
      released_count: r.releasedCount,
      expires_at: r.expiresAt,
      confirmed_at: r.confirmedAt,
      invoice_id: r.invoiceId,
    };
  return receipt ? toRescheduleReceipt(raw) : toRescheduleQuote(raw);
}
/** datetime-local is always Dallas time, even on a traveling client's phone. */
export function parseRescheduleTime(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
  )
    throw new Error("Choose a date and time in Dallas time.");
  const parsed = zonedTimeToUtc(value);
  if (!parsed.ok)
    throw new Error(
      parsed.reason === "nonexistent"
        ? "That time does not exist when the clocks change. Choose another time."
        : "Choose a valid date and time.",
    );
  return parsed;
}
export function parseReschedule(value: unknown) {
  const r = record(value);
  if (r.action === "review")
    return {
      action: "review" as const,
      newStart: parseRescheduleTime(r.localStart).date.toISOString(),
    };
  if (r.action === "confirm" && isChoiceId(r.quoteId))
    return { action: "confirm" as const, quoteId: r.quoteId };
  throw new Error("Review the new time before confirming.");
}
