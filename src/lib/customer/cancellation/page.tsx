import { recurringVisitChanges } from "../recurring/store";
import { RecurringVisitChanges } from "@/components/recurring-visit-changes";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { isChoiceId } from "../cleaner-choice/input";
import { loadCancellation, loadCancellationVisit } from "./store";
import { VisitCancellationForm } from "@/components/visit-cancellation-form";
export async function CancellationPage({
  id,
  office,
  choice,
}: {
  id: string;
  office: boolean;
  choice?: string;
}) {
  const repo = await getRepository(),
    profile = await repo.getCurrentProfile(),
    base = office ? "admin" : "customer";
  if (!repo.isDemo && profile?.role !== (office ? "admin" : "customer"))
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Sign in to manage this visit</h1>
        <Link
          href={`/login?next=${encodeURIComponent(`/${base}/visits/${id}/cancel`)}`}
          className="secondary-action mt-4 inline-flex"
        >
          Sign in
        </Link>
      </section>
    );
  if (!repo.isDemo && !isChoiceId(id)) notFound();
  const customer = office
      ? null
      : await repo.getCustomerByProfile(profile?.id ?? "demo"),
    job = await repo.getJob(id);
  if (!job || (!office && (!customer || job.customerId !== customer.id)))
    notFound();
  const db = repo.isDemo ? null : await createClient(),
    receipt = db ? await loadCancellation(db, id) : null;
  const visit = db
    ? await loadCancellationVisit(db, id)
    : {
        closed: ![
          "unscheduled",
          "scheduled",
          "dispatching",
          "assigned",
        ].includes(job.status),
        recurring: job.frequency !== "one_time",
      };
  const initialReason =
    choice === "skip" && visit.recurring
      ? "skip"
      : choice === "door_turnaway" && office
        ? "door_turnaway"
        : "cancel";
  const seriesChanges = db ? await recurringVisitChanges(db, id) : [];
  return (
    <>
      <Link
        className="mb-5 inline-flex min-h-11 items-center text-sm underline"
        href={`/${base}/visits/${id}`}
      >
        Back to visit
      </Link>
      <h1 className="welcome-title">
        {office ? "Visit cancellation" : "Manage this appointment"}
      </h1>
      <p className="mt-2 text-sm text-ink-2">
        {job.street}, {job.city}
      </p>
      <p className="mt-2 text-sm">
        {job.scheduledStart
          ? formatDateTimeInZone(job.scheduledStart)
          : "Time to be confirmed"}
      </p>
      {job.status === "canceled" &&
      !receipt &&
      seriesChanges.some((c) => c.action === "removed") ? (
        <RecurringVisitChanges changes={seriesChanges} office={office} />
      ) : (
        <>
          <VisitCancellationForm
            key={id}
            jobId={id}
            {...visit}
            initialReason={initialReason}
            receipt={receipt}
            office={office}
            preview={repo.isDemo}
          />
          <RecurringVisitChanges changes={seriesChanges} office={office} />
        </>
      )}
      <p className="mt-5 text-sm">
        Need help?{" "}
        <a
          href="tel:+14692800397"
          className="inline-flex min-h-11 items-center underline"
        >
          Call Hey Spotless
        </a>
        .
      </p>
    </>
  );
}
