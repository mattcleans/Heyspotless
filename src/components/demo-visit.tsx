import Link from "next/link";
import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { JOB_LABELS } from "@/lib/experience/schedule";
import { SERVICE_LABELS } from "@/lib/pricing/price-book";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { formatCents } from "@/lib/money";
import { Pill } from "./ui";

/** Preview fixtures never contact the database or enable live visit actions. */
export async function DemoVisit({ id }: { id: string }) {
  const repo = await getRepository();
  if (!repo.isDemo) notFound();
  const customer = await repo.getCustomerByProfile("demo");
  const jobs = customer ? await repo.listJobs({ customerId: customer.id }) : [];
  const job = jobs.find((job) => job.id === id);
  if (!job) notFound();
  return <>
    <Link href="/customer/visits" className="text-sm text-navy underline">Back to visits</Link>
    <h1 className="welcome-title mt-5">{SERVICE_LABELS[job.service]}</h1>
    <p className="mt-3"><Pill tone={job.status === "complete" ? "good" : "neutral"}>{JOB_LABELS[job.status] ?? "Check visit details"}</Pill></p>
    <dl className="visit-feature mt-5 space-y-4 text-sm">
      <div><dt className="text-ink-2">Appointment</dt><dd className="mt-1 font-semibold text-navy">{job.scheduledStart ? formatDateTimeInZone(job.scheduledStart) : "Time to be confirmed"}</dd></div>
      <div><dt className="text-ink-2">Home</dt><dd className="mt-1">{job.street}, {job.city}</dd></div>
      <div><dt className="text-ink-2">Rooms</dt><dd className="mt-1">{job.bedrooms} bedrooms, {job.bathrooms} bathrooms</dd></div>
      <div><dt className="text-ink-2">Sample visit price</dt><dd className="mt-1">{formatCents(job.priceCents)}</dd></div>
    </dl>
    {!["in_progress","complete","canceled"].includes(job.status) && <Link className="secondary-action mt-4 inline-flex" href={`/customer/visits/${id}/cleaner`}>Preview cleaner preferences</Link>}
    {!["in_progress","complete"].includes(job.status) && <Link className="secondary-action mt-4 inline-flex" href={`/customer/visits/${id}/cancel`}>Preview cancellation details</Link>}
    {!["in_progress","complete","canceled"].includes(job.status) && <Link className="secondary-action mt-4 inline-flex" href={`/customer/visits/${id}/reschedule`}>Preview rescheduling</Link>}
    <p className="preview-note mt-5 rounded-lg">This is a sample visit. Live progress, ratings, and payments are available only for real visits.</p>
    <p className="mt-5 text-sm text-ink-2">Need help with a visit? <a href="tel:+14692800397" className="underline">Call Hey Spotless</a>.</p>
  </>;
}
