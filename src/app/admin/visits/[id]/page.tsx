import Link from "next/link";
import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { loadVisitFacts } from "@/lib/operations/visit-review-store";
import { demoReviewVisits, isReviewId, reviewRooms, reviewState, type VisitFacts, type ReviewPhoto } from "@/lib/operations/visit-review";
import { JOB_LABELS } from "@/lib/experience/schedule";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { formatCents } from "@/lib/money";
import { Pill } from "@/components/ui";
import { VisitRefresh } from "@/components/visit-refresh";
export const dynamic = "force-dynamic";
export const metadata = { title: "Visit review | Hey Spotless management" };
export default async function VisitReviewPage({ params, searchParams }: { params: Promise<{id:string}>; searchParams?:Promise<{photoError?:string}> }) {
  const repo = await getRepository(), profile = await repo.getCurrentProfile();
  if (!repo.isDemo && profile?.role !== "admin") return <section className="visit-feature"><h1 className="text-xl font-semibold">Visit review</h1><p className="mt-3">Sign in with your management account to review this visit.</p><Link href="/login?next=%2Fadmin%2Freview" className="secondary-action mt-3">Sign in</Link></section>;
  const { id } = await params;
  if (!repo.isDemo && !isReviewId(id)) notFound();
  const example = repo.isDemo && id.startsWith("review-sample-") ? demoReviewVisits(await repo.listJobs()).find(v => v.job.id === id) : null;
  const job = example?.job ?? await repo.getJob(id);
  if (!job) notFound();
  const [home,customer] = await Promise.all([repo.getProperty(job.propertyId),repo.getCustomer(job.customerId)]);
  if (!home) throw new Error("Home details are unavailable. Please refresh before reviewing photos.");
  const rooms = reviewRooms(home.rooms);
  const facts: VisitFacts = repo.isDemo ? {
    startedAt: null,completedAt: example?.completedAt ?? null,invoicedAt:null,assignments:[],invoices:[],issues:[],
    photos: id === "review-sample-invoice" ? rooms.flatMap(room => ["before","after"].map(kind => ({id:`sample-${room.key}-${kind}`,roomKey:room.key,kind,takenAt:example!.completedAt!}))) : [],
  } : await loadVisitFacts(await createClient(),id,home.rooms);
  const review = reviewState(job.status,home.rooms,facts);
  const photoLink = (photo: ReviewPhoto) => repo.isDemo ? <span className="text-xs text-ink-3">Sample record</span> : <a className="inline-flex min-h-11 items-center text-sm font-semibold text-navy underline" target="_blank" rel="noopener noreferrer" href={`/api/admin/visits/${id}/photos/${photo.id}`}>View {photo.kind} photo<span className="sr-only">, opens in a new tab</span></a>;
  const photoError = (await searchParams)?.photoError === "unavailable";
  return <>
    {photoError && <div className="visit-feature mb-4 text-sm" role="alert"><p>That photo could not be opened. Refresh this visit and try its photo link again. If it still fails, check storage access with the office.</p><Link href={`/admin/visits/${id}`} className="inline-flex min-h-11 items-center font-semibold underline">Dismiss message</Link></div>}
    <div className="flex flex-wrap gap-4"><Link href="/admin/review" className="inline-flex min-h-11 items-center text-sm underline">Completed visit review</Link><Link href="/admin/schedule" className="inline-flex min-h-11 items-center text-sm underline">Full schedule</Link></div>
    <div className="mt-3 flex flex-wrap items-start justify-between gap-3"><h1 className="text-3xl font-semibold tracking-tight text-navy">{job.customerName}</h1><Pill tone={job.status === "complete" ? "good" : "sky"}>{JOB_LABELS[job.status] ?? "Check visit status"}</Pill></div>
    <p className="mt-2 text-sm text-ink-2">{home.street}, {home.city}</p>
    <div className="mt-4 flex flex-wrap gap-3"><Link href={`/admin/customers/${job.customerId}`} className="secondary-action">Customer details</Link>{customer?.phone && <a className="secondary-action" href={`tel:${customer.phone.replace(/[^+\d]/g,"")}`}>Call customer</a>}<Link href="/admin/dispatch" className="secondary-action">Review matching</Link></div>
    <dl className="card mt-5 grid gap-4 p-5 sm:grid-cols-3">{[["Appointment",job.scheduledStart],["Started",facts.startedAt],["Finished",facts.completedAt]].map(([label,value]) => <div key={String(label)}><dt className="eyebrow">{String(label)}</dt><dd className="mt-1 text-sm">{value instanceof Date ? formatDateTimeInZone(value) : "Not recorded"}</dd></div>)}</dl>
    <section className="visit-feature mt-5"><h2 className="font-semibold text-navy">{review.label}</h2>
      <p className="mt-2 text-sm text-ink-2">{review.key === "photos" ? "The visit is finished, but required photos have not all reached the server. Ask the assigned cleaner to reopen this visit and check the saved-photo queue." : review.key === "ready" ? "The server has the photos required for this home's current room counts. No invoice record is loaded. Check billing follow-up before considering this visit settled." : review.key === "unavailable" ? "The visit has an invoice timestamp, but its invoice record is unavailable. Refresh and check billing records." : review.key === "recorded" ? "An invoice record exists. Its balance and status below describe what is recorded; photo completeness does not confirm payment." : "This visit has not been marked complete. Review the recorded times and assignment before following up."}</p>
      {facts.invoices.map(invoice => <div key={invoice.id} className="mt-3 border-t border-line pt-3 text-sm"><p className="font-semibold">Invoice · {invoice.status}</p><p className="mt-1">Total {formatCents(invoice.totalCents)} · Recorded balance {formatCents(invoice.balanceCents)}</p><p className="mt-1 break-all text-xs text-ink-3">Reference {invoice.id}</p></div>)}
    </section>
    <section className="card mt-5 p-5"><h2 className="font-semibold text-navy">Assigned cleaners</h2><p className="mt-1 text-xs text-ink-2">Up to 50 assignment records. Invoice details above show up to 200 records, newest first.</p>{facts.assignments.length ? <ul className="mt-2 space-y-3">{facts.assignments.map(cleaner => <li key={cleaner.id}><span className="font-medium">{cleaner.name}</span>{cleaner.phone ? <a href={`tel:${cleaner.phone.replace(/[^+\d]/g,"")}`} className="secondary-action ml-3 inline-flex">Call cleaner</a> : <p className="mt-1 text-xs text-ink-2">No phone recorded. Check the office contact records.</p>}</li>)}</ul> : <p className="mt-2 text-sm text-ink-2">No assigned cleaner is recorded for this visit.</p>}</section>
    <section className="mt-6"><h2 className="font-semibold text-navy">Photo evidence</h2><p className="mt-2 text-sm text-ink-2">Required before and after photos for the current room counts of this home. These are server records; photos waiting on a phone are not visible here.</p>
      {review.gaps.length > 0 && <p className="mt-3 text-sm font-semibold text-navy">{review.gaps.reduce((n,g)=>n+g.missing.length,0)} required photos outstanding</p>}
      <ul className="mt-3 space-y-3">{rooms.map(room => <li className="card p-4" key={room.key}><h3 className="font-semibold">{room.label}</h3><div className="mt-2 grid gap-3 sm:grid-cols-2">{["before","after"].map(kind => {const photo=facts.photos.find(p=>p.roomKey===room.key&&p.kind===kind);return <div key={kind}><p className="text-sm">{kind === "before" ? "Before" : "After"} · {photo ? "Recorded on server" : "Not received"}</p>{photo ? photoLink(photo) : null}</div>;})}</div></li>)}</ul>
      {rooms.length === 0 && <p className="mt-3 text-sm text-ink-2">No rooms require photos under the current room counts. Review the home configuration if this is unexpected.</p>}
      {facts.issues.length > 0 && <div className="card mt-4 p-4"><h3 className="font-semibold">Additional issue photos</h3><p className="mt-1 text-xs text-ink-2">Latest 20 records. These do not replace required before and after photos.</p><ul>{facts.issues.map(photo => <li key={photo.id} className="mt-2">{photoLink(photo)}<span className="ml-2 text-xs">{formatDateTimeInZone(photo.takenAt)}</span></li>)}</ul></div>}
    </section>
    <VisitRefresh />
    {facts.startedAt === null && !["in_progress","complete","canceled"].includes(job.status) && <Link href={`/admin/visits/${id}/reschedule`} className="secondary-action mt-5 inline-flex">Reschedule visit</Link>}
    {facts.startedAt === null && job.status !== "complete" && <Link href={`/admin/visits/${id}/cancel`} className="secondary-action mt-5 inline-flex">{job.status === "canceled" ? "View cancellation record" : "Cancel visit or record turnaway"}</Link>}
  </>;
}
