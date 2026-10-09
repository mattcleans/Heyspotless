import { isChoiceId } from "../cleaner-choice/input";
export type RecurringFrequency = "weekly" | "biweekly" | "monthly";
export interface ScheduleDraft {
  firstDate: string;
  frequency: RecurringFrequency;
  startTime: string;
  pausedUntil: string;
  endsOn: string;
}
export interface ScheduleVisit {
  job_id: string | null;
  action: "moved" | "removed" | "added" | "kept";
  previous_start: string | null;
  new_start: string | null;
  previous_occurrence: string | null;
  new_occurrence: string | null;
  previous_epoch: number | null;
  new_epoch: number;
  previous_price_cents: number | null;
  new_price_cents: number | null;
  reason: string;
  released_count: number;
  fills_date: string | null;
}
export interface ScheduleReview {
  plan_id: string;
  effective_from: string;
  first_date: string;
  freq: RecurringFrequency;
  start_time: string;
  paused_until: string | null;
  ends_on: string | null;
  price_cents: number;
  previous_price_cents: number;
  estimated_minutes: number;
  fee_cents: 0;
  horizon_until: string;
  visits: ScheduleVisit[];
  preserved_skips: string[];
}
export interface ScheduleQuote {
  id: string;
  review: ScheduleReview;
  expires_at: string;
}
export interface ScheduleReceipt {
  id: string;
  review: ScheduleReview;
  confirmed_at: string;
}
const fail = () => {
  throw new Error(
    "The schedule could not be verified. Review it again or call the office.",
  );
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
}
export const calendarDay = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
const instant = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(v) &&
  /(Z|[+-]\d{2}:?\d{2})$/.test(v) &&
  Number.isFinite(Date.parse(v));
const cents = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => cents(v) && v > 0;
export const frequency = (v: unknown): v is RecurringFrequency =>
  ["weekly", "biweekly", "monthly"].includes(v as string);
const time = (v: unknown): v is string =>
  typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(v);
const nullable = (v: unknown, check: (v: unknown) => boolean) =>
  v === null || check(v);
export function parseScheduleDraft(value: unknown): ScheduleDraft {
  const r = object(value);
  if (
    !calendarDay(r.firstDate) ||
    !frequency(r.frequency) ||
    !time(r.startTime) ||
    (r.pausedUntil !== "" && !calendarDay(r.pausedUntil)) ||
    (r.endsOn !== "" && !calendarDay(r.endsOn))
  )
    throw new Error(
      "Choose a valid first date, frequency and time in Dallas time.",
    );
  if (r.endsOn && String(r.endsOn) < r.firstDate)
    throw new Error("The last date must be on or after the first date.");
  return {
    firstDate: r.firstDate,
    frequency: r.frequency,
    startTime: r.startTime.slice(0, 5),
    pausedUntil: r.pausedUntil as string,
    endsOn: r.endsOn as string,
  };
}
export function parseScheduleAction(value: unknown) {
  const r = object(value);
  if (r.action === "review")
    return { action: "review" as const, draft: parseScheduleDraft(r.draft) };
  if (r.action === "confirm" && isChoiceId(r.quoteId))
    return { action: "confirm" as const, quoteId: r.quoteId };
  throw new Error("Review the schedule before confirming.");
}
export function toScheduleReview(
  value: unknown,
  saved = false,
): ScheduleReview {
  const r = object(value);
  if (
    !isChoiceId(r.plan_id) ||
    !calendarDay(r.effective_from) ||
    !calendarDay(r.first_date) ||
    r.first_date < r.effective_from ||
    !frequency(r.freq) ||
    !time(r.start_time) ||
    !nullable(r.paused_until, calendarDay) ||
    !nullable(r.ends_on, calendarDay) ||
    !cents(r.price_cents) ||
    !cents(r.previous_price_cents) ||
    !positive(r.estimated_minutes) ||
    r.fee_cents !== 0 ||
    !calendarDay(r.horizon_until) ||
    r.horizon_until < r.first_date ||
    !Array.isArray(r.visits) ||
    r.visits.length > 530 ||
    !Array.isArray(r.preserved_skips) ||
    !r.preserved_skips.every(calendarDay)
  )
    return fail();
  const seen = new Set<string>();
  const visits = r.visits.map((value) => {
    const v = object(value);
    if (
      !["moved", "removed", "added", "kept"].includes(v.action as string) ||
      !nullable(v.job_id, isChoiceId) ||
      !nullable(v.previous_start, instant) ||
      !nullable(v.new_start, instant) ||
      !nullable(v.previous_occurrence, calendarDay) ||
      !nullable(v.new_occurrence, calendarDay) ||
      !nullable(v.previous_epoch, positive) ||
      !positive(v.new_epoch) ||
      !nullable(v.previous_price_cents, cents) ||
      !nullable(v.new_price_cents, cents) ||
      typeof v.reason !== "string" ||
      !v.reason.trim() ||
      v.reason.length > 200 ||
      !cents(v.released_count) ||
      !nullable(v.fills_date, calendarDay)
    )
      return fail();
    if (
      v.action === "added"
        ? v.previous_start !== null ||
          v.previous_epoch !== null ||
          v.previous_price_cents !== null ||
          (!saved && v.job_id !== null) ||
          (saved && !isChoiceId(v.job_id))
        : !isChoiceId(v.job_id)
    )
      return fail();
    if (
      v.action === "removed"
        ? v.new_start !== null || v.new_price_cents !== null
        : (v.action !== "kept" && !instant(v.new_start)) ||
          !cents(v.new_price_cents)
    )
      return fail();
    if (
      v.action === "kept" &&
      (v.new_start !== v.previous_start ||
        v.new_price_cents !== v.previous_price_cents ||
        v.released_count !== 0)
    )
      return fail();
    if (v.job_id) {
      if (seen.has(v.job_id as string)) return fail();
      seen.add(v.job_id as string);
    }
    return Object.fromEntries(
      [
        "job_id",
        "action",
        "previous_start",
        "new_start",
        "previous_occurrence",
        "new_occurrence",
        "previous_epoch",
        "new_epoch",
        "previous_price_cents",
        "new_price_cents",
        "reason",
        "released_count",
        "fills_date",
      ].map((key) => [key, v[key]]),
    ) as unknown as ScheduleVisit;
  });
  return {
    plan_id: r.plan_id,
    effective_from: r.effective_from,
    first_date: r.first_date,
    freq: r.freq,
    start_time: r.start_time.slice(0, 5),
    paused_until: r.paused_until as string | null,
    ends_on: r.ends_on as string | null,
    price_cents: r.price_cents,
    previous_price_cents: r.previous_price_cents,
    estimated_minutes: r.estimated_minutes,
    fee_cents: 0,
    horizon_until: r.horizon_until,
    visits,
    preserved_skips: r.preserved_skips,
  };
}
export function toScheduleQuote(value: unknown): ScheduleQuote {
  const r = object(value);
  if (!isChoiceId(r.id) || !instant(r.expires_at)) return fail();
  return {
    id: r.id,
    review: toScheduleReview(r.review),
    expires_at: r.expires_at,
  };
}
export function toScheduleReceipt(value: unknown): ScheduleReceipt {
  const r = object(value);
  if (!isChoiceId(r.id) || !instant(r.confirmed_at)) return fail();
  return {
    id: r.id,
    review: toScheduleReview(r.review, true),
    confirmed_at: r.confirmed_at,
  };
}
export function receiptMatchesQuote(
  receipt: ScheduleReceipt,
  quote: ScheduleQuote,
) {
  const comparable = (r: ScheduleReview) => ({
    ...r,
    visits: r.visits
      .map((v) => ({ ...v, job_id: v.action === "added" ? null : v.job_id }))
      .sort((a, b) => canonical(a).localeCompare(canonical(b))),
  });
  return (
    receipt.id === quote.id &&
    canonical(comparable(receipt.review)) ===
      canonical(comparable(quote.review))
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
