import Link from "next/link";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { CleanerDirectory } from "@/lib/cleaners/store";
import { Avatar } from "@/components/cleaner-card";
import { AppIcon } from "@/components/app-navigation";
import { Pill } from "@/components/ui";
import { SERVICE_LABELS, SERVICE_TYPES } from "@/lib/pricing/price-book";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { activeVisits } from "@/lib/experience/schedule";
import { STAGES, STAGE_LABELS, type VisitStage } from "@/lib/visits/progress";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your home | Hey Spotless" };
export default async function ClientHome() {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  const customer = profile ? await repo.getCustomerByProfile(profile.id) : null;
  const properties = customer ? await repo.listProperties(customer.id) : [];
  const home = properties[0];
  const jobs = customer ? await repo.listJobs({ customerId: customer.id }) : [];
  const next = activeVisits(jobs)[0];
  const last = jobs
    .filter((j) => j.status === "complete")
    .sort(
      (a, b) =>
        (b.scheduledStart?.getTime() ?? 0) - (a.scheduledStart?.getTime() ?? 0),
    )[0];
  const details = next ? await nextVisit(next.id) : null;
  const stage =
    details?.stage ??
    (next?.status === "in_progress" ? "cleaning" : "scheduled");
  return (
    <>
      <h1 className="welcome-title">
        {customer
          ? `Hey, ${customer.firstName}.`
          : "A little more time for you."}
      </h1>
      <p className="mt-2 text-sm text-ink-2">
        {home
          ? `${home.city}, ${home.zip}`
          : "A clean home. A familiar face. One less thing to do."}
      </p>
      {next && (
        <section aria-labelledby="next-visit">
          <div className="section-heading">
            <h2 id="next-visit">Your next visit</h2>
            <Link href="/customer/visits">All visits</Link>
          </div>
          <div className="visit-feature">
            <Pill tone={stage === "cleaning" ? "good" : "sky"}>
              {next.scheduledStart
                ? STAGE_LABELS[stage]
                : "Time to be confirmed"}
            </Pill>
            <h3 className="mt-3 text-xl font-semibold text-navy">
              {next.scheduledStart
                ? formatDateTimeInZone(next.scheduledStart)
                : "Let’s find your next clean"}
            </h3>
            <p className="mt-1 text-sm text-ink-2">
              {SERVICE_LABELS[next.service]} · {next.bedrooms} bedrooms,{" "}
              {next.bathrooms} bathrooms
            </p>
            <div className="mt-4 flex items-center gap-3">
              {details?.cleaner && <Avatar cleaner={details.cleaner} />}
              <p className="text-sm text-ink-2">
                {details?.cleaner
                  ? `${details.cleaner.fullName}, your cleaner`
                  : "We’ll confirm your cleaner here once matched."}
              </p>
            </div>
            <Link
              className="secondary-action mt-5"
              href={`/customer/visits/${next.id}`}
            >
              {stage === "cleaning"
                ? "Follow your clean"
                : "View visit details"}
            </Link>
          </div>
        </section>
      )}
      <section className="booking-feature">
        <h2>{next ? "Make room for life." : "Come home to a fresh start."}</h2>
        <p>
          Tell us about your home. See your price and request a clean that fits
          your routine.
        </p>
        <Link className="primary-action" href="/book">
          {next ? "Book another clean" : "Build my clean"}
        </Link>
      </section>
      {last && (
        <Link
          href={`/customer/visits/${last.id}/rate`}
          className="visit-feature mt-5 block"
        >
          <strong className="text-navy">How was your last clean?</strong>
          <p className="mt-1 text-sm text-ink-2">
            Leave a rating, add a tip, or tell us what could be better.
          </p>
        </Link>
      )}
      <section aria-labelledby="services">
        <div className="section-heading">
          <h2 id="services">A clean for every occasion</h2>
        </div>
        <div className="service-options">
          {SERVICE_TYPES.map((service, i) => (
            <Link
              key={service}
              className="service-option"
              href={`/book?service=${service}`}
            >
              <AppIcon
                name={i === 0 ? "calendar" : i === 1 ? "sparkle" : "home"}
              />
              {SERVICE_LABELS[service]}
            </Link>
          ))}
        </div>
      </section>
      <section className="care-note">
        <AppIcon name="message" />
        <div>
          <strong>Real people, here to help.</strong>Have a special request or
          need help with a visit? Call{" "}
          <a className="underline" href="tel:+14692800397">
            469-280-0397
          </a>{" "}
          and talk with Hey Spotless.
        </div>
      </section>
    </>
  );
}
async function nextVisit(jobId: string) {
  if (isDemoMode()) return null;
  const db = await createClient();
  const { data, error } = await db
    .from("visit_progress")
    .select("cleaner_id, stage")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) throw new Error("Unable to load your visit. Please try again.");
  if (!data) return null;
  const cleaner =
    typeof data.cleaner_id === "string"
      ? await new CleanerDirectory(db).get(data.cleaner_id)
      : null;
  const stage = STAGES.includes(data.stage as VisitStage)
    ? (data.stage as VisitStage)
    : "scheduled";
  return { cleaner, stage };
}
