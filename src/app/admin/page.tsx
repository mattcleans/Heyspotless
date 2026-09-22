import Link from "next/link";
import { getRepository } from "@/lib/data";
import {
  attentionVisits,
  attentionReason,
  visitsOnDay,
  JOB_LABELS,
} from "@/lib/experience/schedule";
import { formatDateInZone, formatDateTimeInZone } from "@/lib/time/zone";
import { Pill } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Today | Hey Spotless management" };
export default async function OverviewPage() {
  const repo = await getRepository();
  const jobs = await repo.listJobs();
  const now = new Date();
  const today = visitsOnDay(jobs, now);
  const attention = attentionVisits(jobs, now);
  const complete = today.filter((j) => j.status === "complete").length;
  const cleaning = today.filter((j) => j.status === "in_progress").length;
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-2">{formatDateInZone(now)} · Dallas</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-navy">
            A good day starts here.
          </h1>
          <p className="mt-2 text-sm text-ink-2">
            Keep every visit on track and every customer in the loop.
          </p>
        </div>
        <Link href="/admin/customers" className="primary-action">
          Book a customer
        </Link>
      </div>
      <div className="mt-7 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Visits today", today.length],
          ["Cleaning now", cleaning],
          ["Completed", complete],
          ["Need attention", attention.length],
        ].map(([label, value]) => (
          <div key={label} className="card p-5">
            <p className="text-sm text-ink-2">{label}</p>
            <p className="mt-2 text-3xl font-semibold text-navy">{value}</p>
          </div>
        ))}
      </div>
      <div className="mt-8 grid gap-8 lg:grid-cols-[1.2fr_1fr]">
        <section>
          <div className="section-heading !mt-0">
            <h2>Needs your attention</h2>
            <Link href="/admin/dispatch">Open dispatch</Link>
          </div>
          {attention.length ? (
            <ul className="space-y-3">
              {attention.map((job) => (
                <li key={job.id} className="card border-l-4 border-l-cream p-5">
                  <p className="text-sm font-semibold text-navy">
                    {attentionReason(job, now)}
                  </p>
                  <h3 className="mt-2 font-medium">{job.customerName}</h3>
                  <p className="mt-1 text-sm text-ink-2">
                    {job.scheduledStart
                      ? formatDateTimeInZone(job.scheduledStart)
                      : "No visit time set"}{" "}
                    · {job.city}
                  </p>
                  <div className="mt-3 flex gap-4 text-sm">
                    <Link
                      className="text-navy underline"
                      href={`/admin/customers/${job.customerId}`}
                    >
                      Customer details
                    </Link>
                    <Link
                      className="text-navy underline"
                      href="/admin/dispatch"
                    >
                      Review assignment
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="visit-feature">
              <h3 className="font-semibold text-navy">
                No scheduling exceptions found
              </h3>
              <p className="mt-2 text-sm text-ink-2">
                Nothing is missing a time, overdue to start, or awaiting a
                cleaner in the next 24 hours.
              </p>
            </div>
          )}
        </section>
        <section>
          <div className="section-heading !mt-0">
            <h2>Today’s visits</h2>
            <span className="text-xs text-ink-2">In appointment order</span>
          </div>
          {today.length ? (
            <ul className="divide-y divide-line rounded-xl border border-line bg-white px-5">
              {today.map((job) => (
                <li key={job.id} className="py-4">
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      className="font-semibold text-navy underline decoration-line underline-offset-4"
                      href={`/admin/customers/${job.customerId}`}
                    >
                      {job.customerName}
                    </Link>
                    <Pill tone={job.status === "complete" ? "good" : "sky"}>
                      {JOB_LABELS[job.status] ?? job.status}
                    </Pill>
                  </div>
                  <p className="mt-2 text-sm text-ink-2">
                    {formatDateTimeInZone(job.scheduledStart!)} · {job.city}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="visit-feature text-sm text-ink-2">
              No visits scheduled today. Use Customers to arrange a visit.
            </p>
          )}
          <div className="mt-6 rounded-2xl bg-navy-deep p-6 text-white">
            <h2 className="text-lg font-semibold">
              Keep the conversation going
            </h2>
            <p className="mt-2 text-sm text-sky">
              Follow up with leads and help customers with their next clean.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link href="/admin/inbox" className="primary-action">
                Open inbox
              </Link>
              <Link
                href="/admin/leads"
                className="rounded-full border border-white/40 px-5 py-3 text-sm"
              >
                View leads
              </Link>
            </div>
          </div>
        </section>
      </div>
      <p className="mt-8 text-xs text-ink-2">
        This overview uses visits recorded in this app. Housecall Pro activity
        is not synchronized here.
      </p>
    </>
  );
}
