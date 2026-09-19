import Link from "next/link";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { CleanerDirectory } from "@/lib/cleaners/store";
import { Avatar } from "@/components/cleaner-card";
import { Pill } from "@/components/ui";
import { firstName } from "@/lib/cleaners/profile";
import { SERVICE_LABELS, SERVICE_TYPES } from "@/lib/pricing/price-book";
import { STAGE_LABELS, visitHeadline, type VisitStage } from "@/lib/visits/progress";
import { formatDateTimeInZone } from "@/lib/time/zone";

/**
 * Screen 1 — home.
 *
 * The three things somebody opens this for, in the order they want them: am I
 * booked, when is she coming, and how do I book another one. Everything else
 * is a tab away.
 *
 * The service picker below the fold is deliberately a set of links into the
 * booking flow rather than a form — the price is on the next screen, and this
 * one should not be asking anybody to think.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Home" };

export default async function ClientHome() {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  const customer = profile ? await repo.getCustomerByProfile(profile.id) : null;

  const properties = customer ? await repo.listProperties(customer.id) : [];
  const home = properties[0] ?? null;

  const jobs = customer ? await repo.listJobs({ customerId: customer.id, limit: 5 }) : [];

  // The next one that has not finished. A customer who has just had a clean
  // wants the rate screen, not a visit that is already over.
  const next = jobs.find((j) => j.status !== "complete" && j.status !== "canceled") ?? null;
  const justDone = jobs.find((j) => j.status === "complete") ?? null;

  const cleaner = await nextCleaner(next?.id ?? null);

  return (
    <>
      <p className="eyebrow">Good to see you</p>
      <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-navy">
        {customer?.firstName ?? "Welcome"}
      </h1>
      {home ? (
        <p className="mt-0.5 text-sm text-ink-3">
          {home.city}, {home.zip}
        </p>
      ) : null}

      {/* The one thing this screen is for. */}
      <section className="card mt-5 bg-navy p-5 text-white">
        <p className="text-[11px] font-semibold tracking-widest text-sky uppercase">
          Book online in 60 seconds
        </p>
        <p className="mt-1.5 text-lg leading-snug font-semibold">
          You relax. We&apos;ll handle the scrubbing.
        </p>
        <Link
          href="/book"
          className="mt-3 block rounded-lg bg-white px-4 py-3 text-center text-sm font-semibold text-navy"
        >
          Book my clean
        </Link>
      </section>

      {next ? (
        <section className="mt-5">
          <p className="eyebrow mb-2">Your next visit</p>
          <Link
            href={`/customer/visits/${next.id}`}
            className="card block p-4 transition-colors hover:border-sky-deep"
          >
            <div className="flex items-start gap-3">
              {cleaner ? <Avatar cleaner={cleaner} /> : null}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-navy">
                  {visitHeadline(
                    {
                      stage: (next.status === "in_progress" ? "cleaning" : "accepted") as VisitStage,
                      scheduledStart: next.scheduledStart,
                      startedAt: null,
                      completedAt: null,
                      expectedFinishAt: null,
                      roomsDone: 0,
                      roomsTotal: 0,
                    },
                    cleaner ? firstName(cleaner.fullName) : null,
                  )}
                </p>
                <p className="mt-0.5 text-xs text-ink-3">
                  {next.scheduledStart
                    ? formatDateTimeInZone(next.scheduledStart)
                    : "Time to be confirmed"}
                </p>
              </div>
              <Pill tone="sky">
                {next.status === "in_progress" ? "Track" : STAGE_LABELS.accepted}
              </Pill>
            </div>
          </Link>
        </section>
      ) : null}

      {!next && justDone ? (
        <section className="mt-5">
          <p className="eyebrow mb-2">Your last clean</p>
          <Link
            href={`/customer/visits/${justDone.id}/rate`}
            className="card block p-4 transition-colors hover:border-sky-deep"
          >
            <p className="font-medium text-navy">How did it go?</p>
            <p className="mt-0.5 text-xs text-ink-3">
              Rate your clean — it decides who we send back.
            </p>
          </Link>
        </section>
      ) : null}

      <section className="mt-6">
        <p className="eyebrow mb-2">Pick a service</p>
        <div className="grid grid-cols-3 gap-2">
          {SERVICE_TYPES.map((service) => (
            <Link
              key={service}
              href={`/book?service=${service}`}
              className="card p-3 text-center text-xs font-medium text-ink transition-colors hover:border-sky-deep"
            >
              {SERVICE_LABELS[service]}
            </Link>
          ))}
        </div>
      </section>

      <p className="mt-6 text-center text-xs text-ink-3">
        Every cleaner is background-checked and insured before their first visit.
      </p>
    </>
  );
}

/** Who is coming, where the engine has decided. */
async function nextCleaner(jobId: string | null) {
  if (!jobId || isDemoMode()) return null;

  const db = await createClient();
  const { data } = await db
    .from("visit_progress")
    .select("cleaner_id")
    .eq("job_id", jobId)
    .maybeSingle();

  const cleanerId = (data as Record<string, unknown> | null)?.["cleaner_id"];
  if (typeof cleanerId !== "string") return null;

  return new CleanerDirectory(db).get(cleanerId);
}
