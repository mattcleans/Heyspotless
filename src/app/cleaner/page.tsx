import { PageHeader, Callout, Pill } from "@/components/ui";
import { ZIP_CENTROIDS } from "@/lib/config";
import { getRepository } from "@/lib/data";
import { clusterDay, zipCentroidEstimator } from "@/lib/dispatch/route";
import { OPENING_RATE_CENTS_PER_HOUR, payoutForRate } from "@/lib/dispatch/ladder";
import { formatCents, formatHours } from "@/lib/money";

export const metadata = { title: "Today — Spotless Ops" };

const estimate = zipCentroidEstimator(ZIP_CENTROIDS);

export default async function CleanerPage() {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  const cleaner = profile ? await repo.getCleanerByProfile(profile.id) : null;

  const jobs = await repo.listJobs(cleaner ? { cleanerId: cleaner.id } : {});

  // Today's route, ordered to minimise driving rather than by booking time.
  const today = jobs.filter((j) => j.scheduledStart !== null).slice(0, 4);
  const { ordered, totalDriveMinutes } = clusterDay(
    today,
    cleaner?.lastStopZip ?? "75024",
    estimate,
  );

  return (
    <>
      <PageHeader eyebrow="Cleaner" title="Today's route">
        Mobile-first. Offers arrive one at a time with a countdown and a payout in dollars — never a
        percentage, and never a visible ladder.
      </PageHeader>

      <Callout tone="warn" label="Scaffolded, not built">
        This screen shows the route clustering and offer pricing that are implemented and tested.
        Clock in/out with a GPS stamp, room checklists, and the offline photo queue are phase 4 —
        the offline cache matters more than it sounds, because cleaners lose signal inside houses
        and a checklist that discards photos when the connection drops is one nobody uses twice.
      </Callout>

      <p className="mt-6 mb-3 text-sm text-ink-2">
        {ordered.length} jobs · {formatHours(totalDriveMinutes)} driving, clustered from Plano
      </p>

      <ol className="space-y-3">
        {ordered.map((job, i) => (
          <li key={job.id} className="card p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="nums text-xs text-ink-3">{i + 1}</span>
                  <h3 className="font-semibold text-ink">{job.customerName}</h3>
                </div>
                <p className="mt-0.5 text-sm text-ink-3">
                  {job.street}, {job.city}
                </p>
                <p className="mt-1 text-xs text-ink-3">
                  {job.bedrooms}bd/{job.bathrooms}ba · about{" "}
                  {formatHours(job.estimatedCleanMinutes)}
                </p>
              </div>
              <div className="text-right">
                <p className="nums text-lg font-semibold text-navy">
                  {formatCents(payoutForRate(OPENING_RATE_CENTS_PER_HOUR, job.estimatedCleanMinutes))}
                </p>
                <p className="mt-1 text-[11px] text-ink-3">
                  for {formatHours(job.estimatedCleanMinutes)}
                </p>
              </div>
            </div>
            <div className="mt-3 flex gap-2 border-t border-line-soft pt-3">
              <Pill tone="sky">On my way</Pill>
              <Pill>Clock in</Pill>
              <Pill>Checklist</Pill>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
