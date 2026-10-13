import Link from "next/link";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { formatCents } from "@/lib/money";
import { formatDateInZone, toCalendarDate } from "@/lib/time/zone";
import { JOB_LABELS } from "@/lib/experience/schedule";
import { filterPayRecords, parsePayFilter, summarizePayRecords, type PayQuery, type PayRecord } from "@/lib/cleaners/earnings";
import { loadCleanerPay, PAY_RECORD_LIMIT } from "@/lib/cleaners/earnings-store";
import { PayStatement } from "./pay-statement";

export const dynamic = "force-dynamic";
export const metadata = { title: "My pay | Hey Spotless" };
function sampleRecords(): PayRecord[] {
  const now = new Date(), earlier = new Date(now.getTime() - 7 * 86400000);
  return [
    { id: "sample-pending", jobId: null, workCents: 8250, mileageCents: 0, tipCents: 1000, tipFeeCents: 29, tipNetCents: 971, recordedAt: now, paidAt: null, periodStart: null, periodEnd: null },
    { id: "sample-paid", jobId: null, workCents: 9900, mileageCents: 0, tipCents: 2000, tipFeeCents: 58, tipNetCents: 1942, recordedAt: earlier, paidAt: earlier, periodStart: null, periodEnd: null },
  ];
}
export default async function EarningsPage({ searchParams }: { searchParams: Promise<PayQuery> }) {
  const repo = await getRepository(), query = await searchParams;
  const profile = await repo.getCurrentProfile();
  const cleaner = repo.isDemo ? await repo.getCleanerByProfile("demo") : profile?.role === "cleaner" ? await repo.getCleanerByProfile(profile.id) : null;
  if (!cleaner) return <section className="visit-feature">
    <h1 className="text-xl font-semibold text-navy">Your cleaner account</h1>
    <p className="mt-3">Sign in with your cleaner account to review your pay. Call the office if your profile needs to be connected.</p>
    <Link href="/login?next=%2Fcleaner%2Fearnings" className="secondary-action mt-4 inline-flex">Sign in</Link>
  </section>;
  const pay = repo.isDemo ? { records: sampleRecords(), assignments: [], tipsAvailable: true } : await loadCleanerPay(await createClient(), cleaner.id);
  let filtered: PayRecord[] = [], filterError: string | null = null;
  let filter: ReturnType<typeof parsePayFilter> = {
    status: query.status === "paid" || query.status === "pending" ? query.status : "all",
    from: toCalendarDate(query.from), through: toCalendarDate(query.through),
  };
  try { filter = parsePayFilter(query); filtered = filterPayRecords(pay.records, filter); }
  catch (error) { filterError = error instanceof Error ? error.message : "Check the date filters."; }
  const summary = summarizePayRecords(filtered);
  const visits = pay.assignments.filter(assignment => assignment.status !== "canceled");
  return <>
    <h1 className="welcome-title">My pay</h1>
    <p className="mt-3 text-sm text-ink-2">Review recorded payments and amounts awaiting payment. For a missing payment or a full statement, <a href="tel:+14692800397" className="underline">call the office</a>.</p>
    {repo.isDemo && <p className="mt-3 rounded-lg bg-sky-50 p-3 text-sm text-ink-2">These are sample pay records for preview. No payments are sent from this page.</p>}
    {cleaner.type === "w2_core" && <section className="visit-feature mt-5" aria-labelledby="hourly-terms">
      <h2 id="hourly-terms" className="font-semibold text-navy">Your hourly pay</h2>
      {cleaner.terms ? <><p className="mt-2 text-2xl font-semibold text-navy">{formatCents(cleaner.terms.hourlyRateCents)} <span className="text-base font-normal">per hour</span></p>
        {cleaner.terms.guaranteedHoursPerWeek !== null && <p className="mt-2 text-sm">{cleaner.terms.guaranteedHoursPerWeek} guaranteed hours per week on file.</p>}
        <p className="mt-2 text-sm text-ink-2">Your payroll statement includes hours, deductions, and any adjustments. The records below do not calculate your take-home pay.</p></> : <p className="mt-2 text-sm">Ask the office to confirm your hourly terms.</p>}
    </section>}
    <section aria-labelledby="recorded-pay">
      <div className="section-heading"><h2 id="recorded-pay">Recorded pay</h2></div>
      <p className="text-sm text-ink-2">Your {PAY_RECORD_LIMIT} most recent pay records, newest first. Dates and filters use Dallas time. Filter by the date each record was added; payment dates appear separately.</p>
      {!pay.tipsAvailable && <p className="mt-3 rounded-lg border border-line p-3 text-sm">Tip details aren’t available here yet. Amounts below include work and mileage only. Ask the office for your full pay statement.</p>}
      <form key={`${filter.status}|${filter.from}|${filter.through}|${filterError}`} method="get" className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm text-ink-2">Payment status<select name="status" defaultValue={filter.status} className="mt-1 block min-h-11 rounded-lg border border-line bg-white px-3 text-base"><option value="all">All records</option><option value="paid">Recorded paid</option><option value="pending">Awaiting payment</option></select></label>
        <label className="text-sm text-ink-2">Recorded from<input type="date" name="from" defaultValue={filter.from ?? ""} className="mt-1 block min-h-11 max-w-full rounded-lg border border-line bg-white px-3 text-base" /></label>
        <label className="text-sm text-ink-2">Recorded through<input type="date" name="through" defaultValue={filter.through ?? ""} className="mt-1 block min-h-11 max-w-full rounded-lg border border-line bg-white px-3 text-base" /></label>
        <button type="submit" className="primary-action">Filter pay</button><Link href="/cleaner/earnings" className="secondary-action">Clear filters</Link>
      </form>
      {filterError ? <p role="alert" className="mt-4 text-sm text-bad">{filterError} <Link href="/cleaner/earnings" className="underline">Clear filters</Link></p> : filtered.length ? <>
        <dl className="mt-5 grid grid-cols-2 gap-4 border-y border-line py-4">
          <div><dt className="text-sm text-ink-2">{pay.tipsAvailable ? "Recorded paid" : "Work and mileage recorded paid"}</dt><dd className="mt-1 text-xl font-semibold text-navy">{formatCents(summary.paidCents)}</dd></div>
          <div><dt className="text-sm text-ink-2">{pay.tipsAvailable ? "Awaiting payment" : "Work and mileage awaiting payment"}</dt><dd className="mt-1 text-xl font-semibold text-navy">{formatCents(summary.pendingCents)}</dd></div>
        </dl>
        <p className="mt-2 text-xs text-ink-2">Totals cover the {filtered.length} matching {filtered.length === 1 ? "record" : "records"} shown below. They exclude agreed visit amounts.</p>
        <ol className="mt-4 space-y-3">{filtered.map(record => <li key={record.id}><PayStatement record={record} tipsAvailable={pay.tipsAvailable} visitAvailable={pay.assignments.some(visit => visit.jobId === record.jobId)} /></li>)}</ol>
      </> : <div className="visit-feature mt-4"><h3 className="font-semibold text-navy">{pay.records.length ? "No pay records match these filters" : "No pay records yet"}</h3><p className="mt-2 text-sm text-ink-2">{pay.records.length ? "Clear the filters to review your recent records." : "A completed visit does not automatically create a payment record here. Call the office if you expected a payment."}</p></div>}
    </section>
    {cleaner.type === "contractor_1099" && <section aria-labelledby="agreed-pay">
      <div className="section-heading"><h2 id="agreed-pay">Agreed visit pay</h2></div>
      <p className="text-sm text-ink-2">Amounts agreed when visits were assigned. These are separate from payment records above and are not proof of payment. Shows your {PAY_RECORD_LIMIT} most recently assigned visits, excluding canceled visits.</p>
      {visits.length ? <ol className="mt-4 space-y-3">{visits.map(visit => <li key={visit.jobId} className="visit-feature">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold text-navy">{visit.customerName}</h3><p className="font-semibold">{visit.agreedCents > 0 ? formatCents(visit.agreedCents) : "Confirm pay with the office"}</p></div>
        <p className="mt-1 text-sm text-ink-2">{visit.street}</p><p className="mt-2 text-sm">{visit.scheduledStart ? formatDateInZone(visit.scheduledStart) : "Time to be confirmed"}. {JOB_LABELS[visit.status] ?? "Status to be confirmed"}.</p>
        <Link href={`/cleaner/job/${encodeURIComponent(visit.jobId)}`} className="secondary-action mt-3 inline-flex">Open visit</Link>
      </li>)}</ol> : <p className="mt-3 text-sm text-ink-2">No assigned visit pay to show yet. <Link href="/cleaner#offers" className="underline">Check available offers</Link>.</p>}
    </section>}
  </>;
}
