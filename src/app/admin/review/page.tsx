import Link from "next/link";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { listUninvoicedVisits } from "@/lib/operations/visit-review-store";
import { demoReviewVisits, REVIEW_LIMIT } from "@/lib/operations/visit-review";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { Pill } from "@/components/ui";
import { VisitRefresh } from "@/components/visit-refresh";
export const dynamic = "force-dynamic";
export const metadata = { title: "Completed visit review | Hey Spotless management" };
export default async function ReviewPage() {
  const repo = await getRepository(), profile = await repo.getCurrentProfile();
  if (!repo.isDemo && profile?.role !== "admin") return <section className="visit-feature"><h1 className="text-xl font-semibold">Completed visit review</h1><p className="mt-3">Sign in with your management account to review visits.</p><Link href="/login?next=%2Fadmin%2Freview" className="secondary-action mt-3">Sign in</Link></section>;
  const visits = repo.isDemo ? demoReviewVisits(await repo.listJobs()) : await listUninvoicedVisits(await createClient());
  return <>
    <div className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-3xl font-semibold tracking-tight text-navy">Completed visit review</h1><Link href="/admin/schedule" className="secondary-action">Full schedule</Link></div>
    <p className="mt-3 max-w-2xl text-sm text-ink-2">Finished work can still need follow-up. Review required photos, the assigned cleaner, and the invoice record before treating a visit as settled.</p>
    <p className="mt-3 text-xs text-ink-2">Up to {REVIEW_LIMIT} completed visits without an invoice timestamp. Missing completion dates appear first, then the oldest finished visits. Times use Dallas time. Refresh to check for newly uploaded photos.</p>
    <p className="mt-5 text-sm font-semibold text-navy">{visits.length} visit{visits.length === 1 ? "" : "s"} to review{visits.length === REVIEW_LIMIT ? " · Limit reached; review older records first" : ""}</p>
    {visits.length ? <ul className="mt-4 space-y-3">{visits.map(({job,completedAt}) => <li key={job.id} className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><h2 className="font-semibold text-navy">{job.customerName}</h2><Pill tone="warn">Invoice follow-up</Pill></div>
      <p className="mt-2 text-sm text-ink-2">{job.street}, {job.city}</p><p className="mt-1 text-sm text-ink-2">{completedAt ? `Finished ${formatDateTimeInZone(completedAt)}` : "Completion time not recorded"}</p>
      <Link href={`/admin/visits/${job.id}`} className="secondary-action mt-3 inline-flex">Review visit</Link>
    </li>)}</ul> : <div className="visit-feature mt-4"><h2 className="font-semibold text-navy">No uninvoiced completed visits found</h2><p className="mt-2 text-sm text-ink-2">This check covers invoice creation. It does not confirm that issued invoices have been paid.</p><Link className="secondary-action mt-3 inline-flex" href="/admin/reporting">Review reporting</Link></div>}
    <VisitRefresh label="Refresh review" />
  </>;
}
