import Link from "next/link";
import { Pill } from "@/components/ui";
import type { Job } from "@/lib/data/types";
import { JOB_LABELS } from "@/lib/experience/schedule";
import { SERVICE_LABELS } from "@/lib/pricing/price-book";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { formatCents } from "@/lib/money";
import { isDemoMode } from "@/lib/supabase/env";

export function VisitList({ jobs, area }: { jobs: readonly Job[]; area: "customer" | "cleaner" | "admin" }) {
  return <ul className="space-y-3">{jobs.map((job) => <li key={job.id}>
    <Link href={area === "admin" ? `/admin/visits/${job.id}` : `/${area}/${area === "cleaner" ? "job" : "visits"}/${job.id}`} className="visit-feature block hover:border-sky-deep">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="font-semibold text-navy">{area === "customer" ? SERVICE_LABELS[job.service] : job.customerName}</h3>
        <Pill tone={job.status === "complete" ? "good" : job.status === "in_progress" ? "sky" : "neutral"}>{JOB_LABELS[job.status] ?? "Check visit details"}</Pill>
      </div>
      <p className="mt-2 text-sm text-ink-2">{job.scheduledStart ? formatDateTimeInZone(job.scheduledStart) : "Time to be confirmed"}</p>
      <p className="mt-1 text-sm text-ink-2">{job.street}, {job.city}</p>
      {area === "customer" && <p className="mt-2 text-sm text-ink-2">Visit price: {formatCents(job.priceCents)}</p>}
      <span className="mt-3 inline-block text-sm font-semibold text-navy underline">View visit details</span>
    </Link>
    {area === "customer" && job.status === "complete" && !isDemoMode() && <Link href={`/customer/visits/${job.id}/rate`} className="secondary-action mt-2">Rate this clean</Link>}
  </li>)}</ul>;
}
