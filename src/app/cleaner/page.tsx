import Link from "next/link";
import { OfferActions } from "./offer-actions";
import { PushPrompt } from "./push-prompt";
import { Pill } from "@/components/ui";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { formatCents, formatHours } from "@/lib/money";
import { formatDateTimeInZone, formatDateInZone } from "@/lib/time/zone";
import { visitsOnDay, JOB_LABELS } from "@/lib/experience/schedule";
import { SERVICE_LABELS } from "@/lib/pricing/price-book";

export const dynamic = "force-dynamic";
export const metadata = { title: "My day | Hey Spotless" };
export default async function CleanerPage() {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  const cleaner = profile
    ? await repo.getCleanerByProfile(profile.id)
    : repo.isDemo
      ? await repo.getCleanerByProfile("demo")
      : null;
  // Never request the unfiltered job list when a live cleaner has no profile.
  const jobs = cleaner ? await repo.listJobs({ cleanerId: cleaner.id }) : [];
  const offers = cleaner ? await repo.listLiveOffers(cleaner.id) : [];
  const now = new Date();
  const today = visitsOnDay(jobs, now);
  const upcoming = jobs
    .filter(
      (j) =>
        j.scheduledStart &&
        j.scheduledStart > now &&
        !today.some((t) => t.id === j.id) &&
        !["complete", "canceled"].includes(j.status),
    )
    .sort((a, b) => a.scheduledStart!.getTime() - b.scheduledStart!.getTime());
  const payouts = new Map<string, number>();
  if (cleaner && !repo.isDemo && today.length > 0) {
    const db = await createClient();
    const { data, error } = await db
      .from("job_assignments")
      .select("job_id, payout_cents")
      .eq("cleaner_id", cleaner.id)
      .in(
        "job_id",
        today.map((j) => j.id),
      );
    if (error)
      throw new Error("Unable to load your agreed pay. Please try again.");
    for (const row of data ?? [])
      payouts.set(String(row.job_id), Number(row.payout_cents));
  }
  const done = today.filter((j) => j.status === "complete").length;
  return (
    <>
      <p className="text-sm text-ink-2">{formatDateInZone(now)}</p>
      <h1 className="welcome-title mt-2">
        {cleaner
          ? `Hey, ${cleaner.name.split(" ")[0]}.`
          : "Your day, at a glance."}
      </h1>
      <p className="mt-3 text-sm text-ink-2">
        {today.length
          ? `${today.length} visits today. ${done} complete.`
          : "No visits scheduled for today."}
      </p>
      {!cleaner && !repo.isDemo && (
        <div className="visit-feature mt-5">
          <h2 className="font-semibold text-navy">Let’s get you connected</h2>
          <p className="mt-2 text-sm">
            Your account needs a cleaner profile before jobs can appear. Call
            the office for help.
          </p>
        </div>
      )}
      <PushPrompt />
      <section aria-labelledby="schedule">
        <div className="section-heading">
          <h2 id="schedule">Today’s visits</h2>
          <span className="text-xs text-ink-2">Dallas time</span>
        </div>
        {today.length ? (
          <ol className="space-y-3">
            {today.map((job) => (
              <li key={job.id} className="visit-feature">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-navy">
                    {formatDateTimeInZone(job.scheduledStart!)}
                  </p>
                  <Pill tone={job.status === "complete" ? "good" : "sky"}>
                    {JOB_LABELS[job.status] ?? "Scheduled"}
                  </Pill>
                </div>
                <h3 className="mt-3 text-xl font-semibold text-navy">
                  {job.customerName}
                </h3>
                <p className="mt-1 text-sm text-ink-2">
                  {job.street}, {job.city}
                </p>
                <p className="mt-2 text-sm text-ink-2">
                  {SERVICE_LABELS[job.service]} · {job.bedrooms} bed,{" "}
                  {job.bathrooms} bath
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <p className="text-sm text-ink-2">
                    About {formatHours(job.estimatedCleanMinutes)}
                  </p>
                  <p className="text-sm font-semibold text-navy">
                    {cleaner?.type === "w2_core"
                      ? "Paid under your hourly terms"
                      : payouts.has(job.id)
                        ? `${formatCents(payouts.get(job.id)!)} agreed pay`
                        : "Pay details with the office"}
                  </p>
                </div>
                <Link
                  href={`/cleaner/job/${job.id}`}
                  className="primary-action mt-4 w-full"
                >
                  {job.status === "complete"
                    ? "View completed visit"
                    : job.status === "in_progress"
                      ? "Continue this clean"
                      : "Open visit & home notes"}
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <div className="visit-feature">
            <h3 className="font-semibold text-navy">A clear day ahead</h3>
            <p className="mt-2 text-sm text-ink-2">
              Check available offers below, or contact the office if you
              expected a visit.
            </p>
          </div>
        )}
      </section>
      <section
        id="offers"
        aria-labelledby="offers-heading"
        className="scroll-mt-6"
      >
        <div className="section-heading">
          <h2 id="offers-heading">Available offers</h2>
          <span className="text-sm text-ink-2">{offers.length} open</span>
        </div>
        {offers.length ? (
          <ul className="space-y-3">
            {offers.map((offer) => (
              <li key={offer.id} className="card p-5">
                <div className="flex justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-navy">
                      {offer.customerName}
                    </h3>
                    <p className="mt-1 text-sm text-ink-2">{offer.city}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-semibold text-navy">
                      {formatCents(offer.payoutCents)}
                    </p>
                    <p className="text-xs text-ink-2">Visit pay</p>
                  </div>
                </div>
                <p className="mt-3 text-sm text-ink-2">
                  {offer.scheduledStart
                    ? formatDateTimeInZone(offer.scheduledStart)
                    : "Time to be confirmed"}{" "}
                  · About {formatHours(offer.estimatedMinutes)}
                </p>
                {offer.isExclusive && (
                  <p className="mt-3">
                    <Pill tone="good">A familiar home, held for you</Pill>
                  </p>
                )}
                <OfferActions offerId={offer.id} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl bg-surface-2 p-5 text-sm text-ink-2">
            You’re all caught up. New offers will appear here.
          </p>
        )}
      </section>
      {upcoming.length > 0 && (
        <section>
          <div className="section-heading">
            <h2>Coming up next</h2>
          </div>
          <ul className="divide-y divide-line">
            {upcoming.slice(0, 5).map((job) => (
              <li key={job.id}>
                <Link href={`/cleaner/job/${job.id}`} className="block py-4">
                  <p className="font-semibold text-navy">{job.customerName}</p>
                  <p className="mt-1 text-sm text-ink-2">
                    {formatDateTimeInZone(job.scheduledStart!)} · {job.city}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="care-note">
        <div>
          <strong>Something at the home needs attention?</strong>Call{" "}
          <a href="tel:+14692800397" className="underline">
            469-280-0397
          </a>{" "}
          for access problems, unexpected conditions, or help with a visit.
        </div>
      </div>
    </>
  );
}
