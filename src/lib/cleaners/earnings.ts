import { todayIn, toCalendarDate, type CalendarDate } from "@/lib/time/zone";

export interface PayRecord {
  id: string;
  jobId: string | null;
  workCents: number;
  mileageCents: number;
  tipCents: number | null;
  tipFeeCents: number | null;
  tipNetCents: number | null;
  recordedAt: Date;
  paidAt: Date | null;
  periodStart: CalendarDate | null;
  periodEnd: CalendarDate | null;
}
export interface AssignmentPay {
  jobId: string;
  status: string;
  scheduledStart: Date | null;
  customerName: string;
  street: string;
  agreedCents: number;
}
export type PayQuery = Record<string, string | string[] | undefined>;
export interface PayFilter {
  status: "all" | "paid" | "pending";
  from: CalendarDate | null;
  through: CalendarDate | null;
}
export function parsePayFilter(query: PayQuery): PayFilter {
  const status = query.status ?? "all";
  if (status !== "all" && status !== "paid" && status !== "pending") throw new Error("Choose a payment status from the list.");
  const date = (raw: string | string[] | undefined) => {
    if (raw === undefined || raw === "") return null;
    const day = toCalendarDate(raw);
    if (!day) throw new Error("Enter a valid date for each date filter.");
    return day;
  };
  const from = date(query.from), through = date(query.through);
  if (from && through && from > through) throw new Error("The end date must be on or after the start date.");
  return { status, from, through };
}
export function filterPayRecords(records: readonly PayRecord[], filter: PayFilter): PayRecord[] {
  return records.filter(record => {
    const day = todayIn(undefined, record.recordedAt);
    return (filter.status === "all" || (record.paidAt ? "paid" : "pending") === filter.status)
      && (!filter.from || day >= filter.from) && (!filter.through || day <= filter.through);
  });
}
/** Only recorded amounts, never assignment promises or customer ticket prices. */
export function summarizePayRecords(records: readonly PayRecord[]) {
  const tipsKnown = records.every(record => record.tipNetCents !== null);
  const total = (record: PayRecord) => record.workCents + record.mileageCents + (record.tipNetCents ?? 0);
  return {
    tipsKnown,
    workCents: records.reduce((sum, record) => sum + record.workCents, 0),
    mileageCents: records.reduce((sum, record) => sum + record.mileageCents, 0),
    tipNetCents: tipsKnown ? records.reduce((sum, record) => sum + record.tipNetCents!, 0) : null,
    paidCents: records.filter(record => record.paidAt !== null).reduce((sum, record) => sum + total(record), 0),
    pendingCents: records.filter(record => record.paidAt === null).reduce((sum, record) => sum + total(record), 0),
  };
}

type Row = Record<string, unknown>;
function cents(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) throw new Error("Unable to read your recorded pay. Try again or call the office.");
  return raw;
}
function instant(raw: unknown): Date {
  if (typeof raw !== "string" || !Number.isFinite(new Date(raw).getTime())) throw new Error("Unable to read your pay dates. Try again or call the office.");
  return new Date(raw);
}
export function toPayRecord(row: Row, tipsAvailable: boolean): PayRecord {
  const tipCents = tipsAvailable ? cents(row.tip_cents) : null;
  const tipFeeCents = tipsAvailable ? cents(row.tip_fee_cents) : null;
  const tipNetCents = tipsAvailable ? cents(row.tip_net_cents) : null;
  if (tipsAvailable && (tipCents! < 0 || tipFeeCents! < 0 || tipNetCents! < 0 || tipFeeCents! + tipNetCents! !== tipCents)) throw new Error("Your tip details need review. Call the office for your full pay statement.");
  return {
    id: String(row.id), jobId: row.job_id == null ? null : String(row.job_id),
    workCents: cents(row.amount_cents), mileageCents: cents(row.mileage_cents),
    tipCents, tipFeeCents, tipNetCents,
    recordedAt: instant(row.created_at), paidAt: row.paid_at == null ? null : instant(row.paid_at),
    periodStart: toCalendarDate(row.period_start), periodEnd: toCalendarDate(row.period_end),
  };
}
function joined(raw: unknown): Row {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && typeof value === "object" ? value as Row : {};
}
export function toAssignmentPay(row: Row): AssignmentPay {
  const job = joined(row.jobs), customer = joined(job.customers), property = joined(job.properties);
  return {
    jobId: String(row.job_id), status: String(job.status ?? "unknown"),
    scheduledStart: job.scheduled_start == null ? null : instant(job.scheduled_start),
    customerName: [customer.first_name, customer.last_name].filter(value => typeof value === "string").join(" ") || "Assigned visit",
    street: typeof property.street === "string" ? property.street : "",
    agreedCents: cents(row.payout_cents),
  };
}
