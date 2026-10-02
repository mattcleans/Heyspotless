import Link from "next/link";
import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { nextOccurrence } from "@/lib/recurring/schedule";
import {
  addCalendarDays,
  todayIn,
  formatCalendarDate,
  type CalendarDate,
} from "@/lib/time/zone";
import { formatCents } from "@/lib/money";
import { FREQUENCY_LABELS } from "@/lib/pricing/price-book";
import { RecurringScheduleForm } from "@/components/recurring-schedule-form";
import { clientSchedule, clientSchedules, scheduleHistory } from "./store";
import { parseScheduleDraft, type ScheduleDraft } from "./types";
import { isChoiceId } from "../cleaner-choice/input";
export async function SchedulePage({
  id,
  office,
  draft,
}: {
  id: string;
  office: boolean;
  draft?: string;
}) {
  const repo = await getRepository(),
    profile = await repo.getCurrentProfile(),
    base = office ? "admin" : "customer";
  let returned: ScheduleDraft | undefined;
  try {
    if (draft && draft.length < 1000)
      returned = parseScheduleDraft(JSON.parse(draft));
  } catch {
    /* Invalid return links do not replace the plan. */
  }
  if (!repo.isDemo && profile?.role !== (office ? "admin" : "customer"))
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Sign in to manage this schedule</h1>
        <Link
          className="secondary-action mt-4 inline-flex"
          href={`/login?next=${encodeURIComponent(`/${base}/schedules/${id}${returned ? `?draft=${encodeURIComponent(JSON.stringify(returned))}` : ""}`)}`}
        >
          Sign in
        </Link>
      </section>
    );
  if (repo.isDemo)
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Recurring schedule preview</h1>
        <p className="mt-3 text-sm">
          Sign in to review and save changes to your real recurring schedule.
        </p>
        <Link className="secondary-action mt-4 inline-flex" href="/login">
          Sign in
        </Link>
      </section>
    );
  if (!isChoiceId(id)) notFound();
  const db = await createClient(),
    schedule = await clientSchedule(db, id),
    customer = office ? null : await repo.getCustomerByProfile(profile!.id);
  if (
    !schedule ||
    (!office && (!customer || schedule.customerId !== customer.id))
  )
    notFound();
  const minDate = addCalendarDays(todayIn(), 1),
    maxDate = addCalendarDays(minDate, 366);
  const next = nextOccurrence(
    {
      id,
      customerId: schedule.customerId,
      propertyId: "",
      frequency: schedule.frequency,
      anchorDate: schedule.anchorDate as CalendarDate,
      startTime: schedule.startTime,
      endsOn: schedule.endsOn as CalendarDate | null,
      pausedUntil: schedule.pausedUntil as CalendarDate | null,
      active: schedule.active,
      horizonDays: schedule.horizonDays,
      skips: schedule.skips as CalendarDate[],
    },
    minDate,
  );
  const initialDraft = returned ?? {
    firstDate: next?.date ?? minDate,
    frequency: schedule.frequency,
    startTime: schedule.startTime,
    pausedUntil: schedule.pausedUntil ?? "",
    endsOn: schedule.endsOn ?? "",
  };
  const history = await scheduleHistory(db, id);
  return (
    <>
      <Link
        className="mb-5 inline-flex min-h-11 items-center text-sm underline"
        href={
          office
            ? `/admin/customers/${schedule.customerId}/schedules`
            : "/customer/schedules"
        }
      >
        Back to recurring schedules
      </Link>
      <h1 className="welcome-title">Change your recurring schedule</h1>
      <p className="mt-2 text-sm text-ink-2">
        {schedule.street}, {schedule.city}
      </p>
      <p className="mt-3 text-sm">
        Current pattern:{" "}
        {schedule.frequency === "biweekly"
          ? "Every two weeks"
          : FREQUENCY_LABELS[schedule.frequency]}{" "}
        · {schedule.startTime} Dallas time · {formatCents(schedule.priceCents)}{" "}
        per clean
      </p>
      {schedule.active ? (
        <RecurringScheduleForm
          planId={id}
          initialDraft={initialDraft}
          minDate={minDate}
          maxDate={maxDate}
          office={office}
          service={schedule.service}
        />
      ) : (
        <section className="visit-feature mt-5">
          <h2 className="font-semibold text-navy">
            This recurring pattern is inactive
          </h2>
          <p className="mt-2 text-sm">
            Saved changes below remain available. Call the office to restart
            recurring service.
          </p>
        </section>
      )}
      {history.length > 0 && (
        <section className="mt-6">
          <h2 className="font-semibold text-navy">Recent saved changes</h2>
          <ol className="mt-3 divide-y divide-line">
            {history.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                {r.review.freq === "biweekly"
                  ? "Every two weeks"
                  : FREQUENCY_LABELS[r.review.freq]}{" "}
                from {formatCalendarDate(r.review.first_date as CalendarDate)} ·{" "}
                {formatCents(r.review.price_cents)} per pattern visit
                <p className="mt-1 text-xs text-ink-2">
                  {r.review.visits.filter((v) => v.action === "moved").length}{" "}
                  moved ·{" "}
                  {r.review.visits.filter((v) => v.action === "kept").length}{" "}
                  kept ·{" "}
                  {r.review.visits.filter((v) => v.action === "removed").length}{" "}
                  removed ·{" "}
                  {r.review.visits.filter((v) => v.action === "added").length}{" "}
                  added
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="mt-5 text-sm">
        Need help?{" "}
        <a
          className="inline-flex min-h-11 items-center underline"
          href="tel:+14692800397"
        >
          Call Hey Spotless
        </a>
        .
      </p>
    </>
  );
}
export async function ScheduleListPage({
  office = false,
  customerId,
}: {
  office?: boolean;
  customerId?: string;
}) {
  const repo = await getRepository(),
    profile = await repo.getCurrentProfile();
  if (!repo.isDemo && profile?.role !== (office ? "admin" : "customer"))
    return (
      <section className="visit-feature">
        <h1 className="welcome-title">Sign in to view recurring schedules</h1>
        <Link
          className="secondary-action mt-4 inline-flex"
          href={`/login?next=${encodeURIComponent(office ? `/admin/customers/${customerId}/schedules` : "/customer/schedules")}`}
        >
          Sign in
        </Link>
      </section>
    );
  const customer = office
    ? customerId && isChoiceId(customerId)
      ? await repo.getCustomer(customerId)
      : null
    : await repo.getCustomerByProfile(profile?.id ?? "demo");
  if (office && !customer) notFound();
  let schedules: Awaited<ReturnType<typeof clientSchedules>> = [],
    error = "";
  try {
    if (customer && !repo.isDemo)
      schedules = await clientSchedules(await createClient(), customer.id);
  } catch {
    error =
      "Your recurring schedules could not be loaded. Refresh or call the office before making changes.";
  }
  return (
    <>
      <Link
        className="mb-5 inline-flex min-h-11 items-center text-sm underline"
        href={office ? `/admin/customers/${customerId}` : "/customer/account"}
      >
        {office ? "Back to client" : "Back to account"}
      </Link>
      <h1 className="welcome-title">Recurring schedules</h1>
      <p className="mt-3 text-sm text-ink-2">
        Change your frequency, day or time. You review the affected visits and
        price before anything is saved.
      </p>
      {repo.isDemo && (
        <p className="visit-feature mt-5 text-sm">
          Preview only. Sign in to manage your real recurring schedules.
        </p>
      )}
      {error && (
        <p role="alert" className="visit-feature mt-5 text-sm">
          {error}
        </p>
      )}
      {!error && !repo.isDemo && schedules.length === 0 && (
        <p className="visit-feature mt-5 text-sm">
          {customer
            ? "No active recurring schedule is connected to this account."
            : "Your account needs to be connected to your client profile."}{" "}
          <a className="underline" href="tel:+14692800397">
            Call the office
          </a>{" "}
          for help.
        </p>
      )}
      <ul className="mt-5 space-y-3">
        {schedules.map((s) => (
          <li key={s.id} className="visit-feature">
            <p className="font-semibold text-navy">{s.street}</p>
            <p className="mt-2 text-sm">
              {s.frequency === "biweekly"
                ? "Every two weeks"
                : FREQUENCY_LABELS[s.frequency]}{" "}
              · {s.startTime} Dallas time · {formatCents(s.priceCents)} per
              clean
            </p>
            {s.pausedUntil && (
              <p className="mt-2 text-sm text-ink-2">
                Paused through{" "}
                {formatCalendarDate(s.pausedUntil as CalendarDate)}
              </p>
            )}
            {s.endsOn && (
              <p className="mt-1 text-sm text-ink-2">
                Ends {formatCalendarDate(s.endsOn as CalendarDate)}
              </p>
            )}
            <Link
              className="secondary-action mt-4 inline-flex"
              href={`/${office ? "admin" : "customer"}/schedules/${s.id}`}
            >
              Review schedule changes
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
