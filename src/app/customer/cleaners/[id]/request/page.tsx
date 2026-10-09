import Link from "next/link";
import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { CleanerDirectory } from "@/lib/cleaners/store";
import { isChoiceId } from "@/lib/customer/cleaner-choice/input";
import { formatDateTimeInZone } from "@/lib/time/zone";
export const dynamic = "force-dynamic";
export const metadata = { title: "Choose a visit | Hey Spotless" };
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isChoiceId(id)) notFound();
  const repo = await getRepository(),
    profile = await repo.getCurrentProfile();
  if (repo.isDemo || profile?.role !== "customer")
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Sign in to choose your visit</h1>
        <Link
          href={`/login?next=${encodeURIComponent(`/customer/cleaners/${id}/request`)}`}
          className="secondary-action mt-4 inline-flex"
        >
          Sign in
        </Link>
      </section>
    );
  const customer = await repo.getCustomerByProfile(profile.id);
  if (!customer) notFound();
  const cleaner = await new CleanerDirectory(await createClient()).get(id);
  if (!cleaner) notFound();
  const jobs = await repo.listJobs({ customerId: customer.id, limit: 100 });
  const homes = await repo.listProperties(customer.id);
  const visits = jobs.filter(
    (j) =>
      !["in_progress", "complete", "canceled"].includes(j.status) &&
      homes.some(
        (h) =>
          h.id === j.propertyId &&
          (!cleaner.serviceZips.length || cleaner.serviceZips.includes(h.zip)),
      ),
  );
  return (
    <>
      <Link
        className="inline-flex min-h-11 items-center text-sm underline"
        href={`/customer/cleaners/${id}`}
      >
        Back to profile
      </Link>
      <h1 className="welcome-title mt-4">Which visit is this for?</h1>
      <p className="mt-3 text-sm text-ink-2">
        Request {cleaner.fullName} for one of your unstarted visits in their
        service area. Review and send your preference on the next screen.
      </p>
      {visits.length ? (
        <ul className="mt-5 space-y-3">
          {visits.map((j) => (
            <li key={j.id}>
              <Link
                className="visit-feature block"
                href={`/customer/visits/${j.id}/cleaner?preferred=${id}`}
              >
                <strong>
                  {j.scheduledStart
                    ? formatDateTimeInZone(j.scheduledStart)
                    : "Time to be confirmed"}
                </strong>
                <p className="mt-2 text-sm">
                  {j.street}, {j.city}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="visit-feature mt-5">
          No eligible upcoming visits found in your latest 100 records. Call the
          office to arrange a visit or check the service area.
        </p>
      )}
    </>
  );
}
