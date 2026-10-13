import { isChoiceId } from "../cleaner-choice/input";
export type CancellationReason = "cancel" | "skip" | "door_turnaway";
export interface CancellationQuote {
  id: string;
  jobId: string;
  reason: CancellationReason;
  scheduledStart: string | null;
  feeCents: number;
  expiresAt: string;
}
export interface CancellationReceipt {
  id: string;
  jobId: string;
  reason: CancellationReason;
  scheduledStart: string | null;
  feeCents: number;
  invoiceId: string | null;
  billingReview: boolean;
  canceledAt: string;
}
const validDate = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
export function cancellationRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Review this cancellation again.");
  return value as Record<string, unknown>;
}
function common(value: unknown) {
  const r = cancellationRecord(value);
  if (
    !isChoiceId(r.id) ||
    !isChoiceId(r.job_id) ||
    !["cancel", "skip", "door_turnaway"].includes(String(r.reason)) ||
    ![0, 6000].includes(r.fee_cents as number) ||
    (r.scheduled_start !== null && !validDate(r.scheduled_start))
  )
    throw new Error("Cancellation details could not be confirmed.");
  return {
    id: r.id,
    jobId: r.job_id,
    reason: r.reason as CancellationReason,
    scheduledStart: r.scheduled_start as string | null,
    feeCents: r.fee_cents as number,
  };
}
export function toCancellationQuote(value: unknown): CancellationQuote {
  const r = cancellationRecord(value),
    base = common(value);
  if (!validDate(r.expires_at)) throw new Error("Cancellation review expired.");
  return { ...base, expiresAt: r.expires_at };
}
export function toCancellationReceipt(value: unknown): CancellationReceipt {
  const r = cancellationRecord(value),
    base = common(value);
  if (
    !validDate(r.canceled_at) ||
    typeof r.billing_review !== "boolean" ||
    (r.invoice_id !== null && !isChoiceId(r.invoice_id)) ||
    (r.billing_review && r.invoice_id !== null) ||
    (!r.billing_review && base.feeCents > 0 && r.invoice_id === null)
  )
    throw new Error("Cancellation receipt could not be confirmed.");
  return {
    ...base,
    canceledAt: r.canceled_at,
    billingReview: r.billing_review,
    invoiceId: r.invoice_id as string | null,
  };
}
export function parseCancellation(value: unknown) {
  const b = cancellationRecord(value);
  if (
    b.action === "review" &&
    ["cancel", "skip", "door_turnaway"].includes(String(b.reason))
  )
    return {
      action: "review" as const,
      reason: b.reason as CancellationReason,
    };
  if (b.action === "confirm" && isChoiceId(b.quoteId))
    return { action: "confirm" as const, quoteId: b.quoteId };
  throw new Error("Review the cancellation and its fee before confirming.");
}
// Revalidate API responses before the browser claims a saved result.
export function checkedCancellationQuote(value: unknown) {
  const r = cancellationRecord(value);
  return toCancellationQuote({
    id: r.id,
    job_id: r.jobId,
    reason: r.reason,
    scheduled_start: r.scheduledStart,
    fee_cents: r.feeCents,
    expires_at: r.expiresAt,
  });
}
export function checkedCancellationReceipt(value: unknown) {
  const r = cancellationRecord(value);
  return toCancellationReceipt({
    id: r.id,
    job_id: r.jobId,
    reason: r.reason,
    scheduled_start: r.scheduledStart,
    fee_cents: r.feeCents,
    invoice_id: r.invoiceId,
    billing_review: r.billingReview,
    canceled_at: r.canceledAt,
  });
}
