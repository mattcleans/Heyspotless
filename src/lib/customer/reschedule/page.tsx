import Link from "next/link";
import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { isChoiceId } from "../cleaner-choice/input";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { formatCents } from "@/lib/money";
import { loadRescheduleVisit, rescheduleHistory } from "./store";
import { parseRescheduleTime } from "./types";
import { VisitRescheduleForm } from "@/components/visit-reschedule-form";
export async function ReschedulePage({
  id,
  office,
  start,
}: {
  id: string;
  office: boolean;
  start?: string;
}) {
  const repo = await getRepository(),
    profile = await repo.getCurrentProfile(),
    base = office ? "admin" : "customer",
    back = `/${base}/visits/${id}`;
  let initialStart = "";
  try {
    if (start) {
      parseRescheduleTime(start);
      initialStart = start;
    }
  } catch {
    /* Invalid return links never override the current appointment. */
  }
  if (!repo.isDemo && profile?.role !== (office ? "admin" : "customer"))
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Sign in to manage this visit</h1>
        <Link
          href={`/login?next=${encodeURIComponent(`${back}/reschedule${initialStart ? `?start=${encodeURIComponent(initialStart)}` : ""}`)}`}
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
  const db = repo.isDemo ? null : await createClient();
  const visit = db
    ? await loadRescheduleVisit(db, id)
    : {
        closed: ["in_progress", "complete", "canceled"].includes(job.status),
        recurring: job.frequency !== "one_time",
      };
  const history = db ? await rescheduleHistory(db, id) : [];
  return (
    <>
      <Link
        href={back}
        className="mb-5 inline-flex min-h-11 items-center text-sm underline"
      >
        Back to visit
      </Link>
      <h1 className="welcome-title">Reschedule this visit</h1>
      <p className="mt-2 text-sm text-ink-2">
        {job.street}, {job.city}
      </p>
      <p className="mt-2 text-sm">
        Current appointment:{" "}
        {job.scheduledStart
          ? formatDateTimeInZone(job.scheduledStart)
          : "Time to be confirmed"}
      </p>
      <VisitRescheduleForm
        jobId={id}
        currentStart={job.scheduledStart?.toISOString() ?? null}
        {...visit}
        office={office}
        preview={repo.isDemo}
        initialStart={initialStart}
      />
      {history.length > 0 && (
        <section className="mt-6">
          <h2 className="font-semibold text-navy">
            Recent appointment changes
          </h2>
          <p className="mt-1 text-xs text-ink-2">
            Latest five saved changes. The current appointment is shown above.
          </p>
          <ol className="mt-3 space-y-3">
            {history.map((r) => (
              <li key={r.id} className="card p-4 text-sm">
                <p>Moved to {formatDateTimeInZone(new Date(r.newStart))}</p>
                <p className="mt-1 text-xs text-ink-2">
                  Saved {formatDateTimeInZone(new Date(r.confirmedAt))} ·{" "}
                  {r.feeCents
                    ? `${formatCents(r.feeCents)} rescheduling fee`
                    : "No rescheduling fee"}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
      {!office && history.some((r) => r.feeCents > 0) && (
        <Link
          href="/customer/account"
          className="secondary-action mt-4 inline-flex"
        >
          View fee invoices in your account
        </Link>
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
