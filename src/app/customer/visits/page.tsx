import Link from "next/link";
import { getRepository } from "@/lib/data";
import { Pill } from "@/components/ui";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { formatCents } from "@/lib/money";

/**
 * The Visits tab — everything booked and everything done.
 *
 * Upcoming first, because that is what somebody opening this tab is checking.
 * A finished clean that has not been rated carries the prompt, since the
 * rating is what the eligibility gate runs on and the ask is easy to miss in
 * a text.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Your visits" };

export default async function VisitsPage() {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  const customer = profile ? await repo.getCustomerByProfile(profile.id) : null;

  const jobs = customer ? await repo.listJobs({ customerId: customer.id, limit: 40 }) : [];

  const upcoming = jobs
    .filter((j) => j.status !== "complete" && j.status !== "canceled")
    .sort((a, b) => (a.scheduledStart?.getTime() ?? 0) - (b.scheduledStart?.getTime() ?? 0));

  const past = jobs
    .filter((j) => j.status === "complete")
    .sort((a, b) => (b.scheduledStart?.getTime() ?? 0) - (a.scheduledStart?.getTime() ?? 0));

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-navy">Your visits</h1>

      {jobs.length === 0 ? (
        <div className="card mt-4 p-6 text-center text-sm text-ink-3">
          Nothing booked yet.{" "}
          <Link href="/book" className="text-navy underline">
            Book a clean
          </Link>
          .
        </div>
      ) : null}

      {upcoming.length > 0 ? (
        <section className="mt-4">
          <p className="eyebrow mb-2">Coming up</p>
          <ul className="space-y-2">
            {upcoming.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/customer/visits/${job.id}`}
                  className="card flex items-center justify-between gap-3 p-4 transition-colors hover:border-sky-deep"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-navy">{job.service}</p>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {job.scheduledStart
                        ? formatDateTimeInZone(job.scheduledStart)
                        : "Time to be confirmed"}
                    </p>
                  </div>
                  <Pill tone={job.status === "in_progress" ? "sky" : "neutral"}>
                    {job.status === "in_progress" ? "In progress" : "Booked"}
                  </Pill>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {past.length > 0 ? (
        <section className="mt-6">
          <p className="eyebrow mb-2">Done</p>
          <ul className="space-y-2">
            {past.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/customer/visits/${job.id}/rate`}
                  className="card flex items-center justify-between gap-3 p-4 transition-colors hover:border-sky-deep"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{job.service}</p>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {job.scheduledStart ? formatDateTimeInZone(job.scheduledStart) : ""} ·{" "}
                      {formatCents(job.priceCents)}
                    </p>
                  </div>
                  <Pill>Rate</Pill>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
