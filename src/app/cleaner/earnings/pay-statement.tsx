import Link from "next/link";
import { formatCents } from "@/lib/money";
import { formatCalendarDate, formatDateInZone } from "@/lib/time/zone";
import type { PayRecord } from "@/lib/cleaners/earnings";

export function PayStatement({ record, tipsAvailable, visitAvailable }: { record: PayRecord; tipsAvailable: boolean; visitAvailable: boolean }) {
  const total = record.workCents + record.mileageCents + (record.tipNetCents ?? 0);
  const parts = [["Work", record.workCents], ["Mileage", record.mileageCents]] as const;
  return <article className="visit-feature">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold text-navy">{record.paidAt ? "Recorded paid" : "Awaiting payment"}</h3><p className="mt-1 text-sm text-ink-2">Recorded {formatDateInZone(record.recordedAt)}</p></div>
      <p className="text-xl font-semibold text-navy">{formatCents(total)}{!tipsAvailable && <span className="block text-xs font-normal text-ink-2">Work and mileage subtotal</span>}</p>
    </div>
    <dl className="mt-4 space-y-2 text-sm">{parts.map(([label, amount]) => <div key={label} className="flex justify-between gap-3"><dt>{label}</dt><dd>{formatCents(amount)}</dd></div>)}
      {tipsAvailable && <><div className="flex justify-between gap-3"><dt>Customer tip</dt><dd>{formatCents(record.tipCents!)}</dd></div><div className="flex justify-between gap-3"><dt>Tip processing fee</dt><dd>{formatCents(record.tipFeeCents!)}</dd></div><div className="flex justify-between gap-3"><dt>Tip to you</dt><dd>{formatCents(record.tipNetCents!)}</dd></div></>}
    </dl>
    {record.periodStart && record.periodEnd && <p className="mt-3 text-sm text-ink-2">Pay period: {formatCalendarDate(record.periodStart)} to {formatCalendarDate(record.periodEnd)}.</p>}
    <p className="mt-3 text-sm text-ink-2">{record.paidAt ? `Marked paid ${formatDateInZone(record.paidAt)}. Call the office if the payment has not reached you.` : "No payment date is recorded yet. Ask the office about timing."}</p>
    {record.jobId && visitAvailable && <Link href={`/cleaner/job/${encodeURIComponent(record.jobId)}`} className="secondary-action mt-3 inline-flex">Open visit</Link>}
  </article>;
}
