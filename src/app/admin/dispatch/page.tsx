import { createClient } from "@/lib/supabase/server";
import { matchingCalendarInputs } from "@/lib/dispatch/calendar-context";
import Link from "next/link";
import { DispatchRecommendation } from "@/components/dispatch-recommendation";
import { JOB_LABELS } from "@/lib/experience/schedule";
import { Pill, Stat, Callout } from "@/components/ui";
import { AVERAGE_TICKET_CENTS, ZIP_CENTROIDS } from "@/lib/config";
import { getRepository } from "@/lib/data";
import type { Job } from "@/lib/data/types";
import {
  dispatchBoard,
  hoursUntil,
  residualGuaranteedHours,
  type DispatchDecision,
  type DispatchContext,
  scheduledHoursInWeek,
} from "@/lib/dispatch/engine";
import { zipCentroidEstimator } from "@/lib/dispatch/route";
import { checkEligibility, REASON_LABELS } from "@/lib/dispatch/eligibility";
import type { Cleaner } from "@/lib/dispatch/types";
import { formatCents, formatHours, formatPct } from "@/lib/money";
import { employeeWeekPlan } from "@/lib/dispatch/employee-week-plan";
import { matchingWeek } from "@/lib/dispatch/week";
import { addCalendarDays, formatCalendarDate, formatDateTimeInZone } from "@/lib/time/zone";
import { SERVICE_LABELS, FREQUENCY_LABELS } from "@/lib/pricing/price-book";

export const metadata = { title: "Matching plan | Hey Spotless management" };

const estimate = zipCentroidEstimator(ZIP_CENTROIDS);

function buildContext(cleaners: Cleaner[], now: Date, calendar: Pick<DispatchContext, "eligibilityFor" | "priorJobsFor" | "scheduledHoursFor"> = {}) {
  return {
    now,
    cleaners,
    driveFor: (c: Cleaner, j: { zip: string }) => estimate(c.lastStopZip, j.zip),
    // Deterministic so the board does not reshuffle between renders.
    rng: () => 0.5,
    ...calendar,
  };
}

function JobCard({ job, decision, now }: { job: Job; decision: DispatchDecision; now: Date }) {
  const hours = hoursUntil(job, now);

  return (
    <li className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-semibold text-ink">{job.customerName}</h3>
        <span className="nums text-sm text-navy">{formatCents(job.priceCents)}</span>
      </div>
      <p className="mt-2 text-sm font-medium text-navy">
        {JOB_LABELS[job.status] ?? "Check visit status"}
      </p>
      <p className="mt-0.5 text-sm text-ink-3">
        {job.street}, {job.city} · {job.bedrooms}bd/{job.bathrooms}ba
      </p>
      <p className="mt-1.5 text-xs text-ink-3">
        {SERVICE_LABELS[job.service]} · {FREQUENCY_LABELS[job.frequency]} ·{" "}
        {formatHours(job.estimatedCleanMinutes)} ·{" "}
        {job.scheduledStart
          ? Number.isFinite(hours)
            ? hours < 0
              ? "Past appointment · review visit status"
              : formatDateTimeInZone(job.scheduledStart)
            : "unscheduled"
          : "unscheduled"}
      </p>
      <div className="mt-3.5 border-t border-line-soft pt-3.5">
        <DispatchRecommendation decision={decision} priceCents={job.priceCents} now={now} />
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link href={`/admin/visits/${job.id}`} className="secondary-action">
          Review visit
        </Link>
        <Link href={`/admin/customers/${job.customerId}`} className="secondary-action">
          Customer details
        </Link>
      </div>
    </li>
  );
}

function CleanerRow({
  cleaner,
  unspent,
  probe,
  eligibilityFor,
}: {
  cleaner: Cleaner;
  unspent: number;
  probe: Job | undefined;
  eligibilityFor: DispatchContext["eligibilityFor"];
}) {
  // Show why an ineligible cleaner is invisible to dispatch, using a real job so
  // the reason is concrete rather than hypothetical.
  const eligibility = probe
    ? checkEligibility(cleaner, probe, eligibilityFor?.(cleaner, probe))
    : { eligible: true, reasons: [] as const };

  const unknownAssignment = probe ? eligibilityFor?.(cleaner, probe).busyWindows?.find(w => w.requiresReview && w.jobId) : undefined;
  return (
    <tr className="border-b border-line-soft last:border-0">
      <td className="px-4 py-2.5">
        <span className="font-medium text-ink">{cleaner.name}</span>
        <span className="ml-2 text-xs text-ink-3">
          {cleaner.type === "w2_core" ? "W-2" : "1099"}
        </span>
      </td>
      <td className="nums px-4 py-2.5 text-sm">{cleaner.rating?.toFixed(1) ?? "—"}</td>
      <td className="nums px-4 py-2.5 text-sm">
        {cleaner.acceptanceRate != null ? formatPct(cleaner.acceptanceRate, 0) : "—"}
      </td>
      <td className="nums px-4 py-2.5 text-sm">{cleaner.hoursScheduledThisWeek.toFixed(1)}h</td>
      <td className="nums px-4 py-2.5 text-sm">
        {cleaner.terms?.guaranteedHoursPerWeek ? `${unspent.toFixed(1)}h` : "—"}
      </td>
      <td className="px-4 py-2.5">
        {!probe ? <Pill tone="neutral">Awaiting appointment</Pill> : eligibility.eligible ? (
          <Pill tone="good">Eligible</Pill>
        ) : (
          <span title={eligibility.reasons.map((r) => REASON_LABELS[r]).join(" · ")}>
            <Pill tone="bad">{REASON_LABELS[eligibility.reasons[0]!]}</Pill>
          </span>
        )}
        {unknownAssignment?.jobId && <Link className="mt-2 inline-flex min-h-11 items-center text-xs underline" href={`/admin/visits/${encodeURIComponent(unknownAssignment.jobId)}`}>Review assignment time</Link>}
      </td>
    </tr>
  );
}

export default async function DispatchPage() {
  const repo = await getRepository();
  if (!repo.isDemo && (await repo.getCurrentProfile())?.role !== "admin") return <section className="visit-feature"><h1 className="text-xl font-semibold">Matching plan</h1><p className="mt-3">Sign in with your Management account to review matching.</p><Link href="/login?next=%2Fadmin%2Fdispatch" className="secondary-action mt-3">Sign in</Link></section>;
  const [jobs, cleaners] = await Promise.all([
    repo.listJobs({ needingCleaner: true }),
    repo.listCleaners(),
  ]);

  const now = new Date();
  const calendar = repo.isDemo ? {} : await matchingCalendarInputs(await createClient(), jobs, now);
  const context = buildContext(cleaners, now, calendar);

  // Plan the whole board at once. Deciding each job independently would tell
  // every job the same guaranteed hours are free, and six jobs would each claim
  // the same unspent hours. Capacity is consumed as it is allocated.
  const board = dispatchBoard(jobs, context);
  const residual = residualGuaranteedHours(board, context);

  const weeklyPlan = employeeWeekPlan(board, context, AVERAGE_TICKET_CENTS);
  const currentWeek = matchingWeek(now);
  const currentRoster = cleaners.map(cleaner => ({
    ...cleaner, hoursScheduledThisWeek: scheduledHoursInWeek(cleaner, currentWeek, context),
  }));

  const needsScheduling = board.filter(e => e.decision.kind === "needs_scheduling").length;

  const needMarket = board.filter(
    (e) => e.decision.kind === "waterfall" || e.decision.kind === "open_board",
  ).length;

  return (
    <>
      <div className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight text-navy">Matching plan</h1>
        <p className="mt-3 max-w-3xl text-sm text-ink-2">
        Review suggested cleaners and estimated costs for visits needing a match.
        This page recalculates a plan; opening it does not send offers or assign cleaners.
        Open a visit to check its saved assignment and approval status.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Jobs needing a cleaner" value={String(jobs.length)} />
        <Stat label="Suggested contractor offers" value={String(needMarket)}
          note="Proposed open offers or timed offers; not confirmation that they were sent" />
      </div>

      {needsScheduling > 0 && <div className="mt-4">
        <Callout tone="warn" label="Appointments need review">
          {needsScheduling} visits need a valid future appointment before matching.
          Review their saved visit status with the Client; they remain on the board below.
        </Callout>
      </div>}
      <section className="mt-8" aria-labelledby="weekly-plan-heading">
        <h2 id="weekly-plan-heading" className="text-lg font-semibold text-navy">Employee weeks</h2>
        <p className="mt-2 max-w-3xl text-sm text-ink-2">
          Each Monday–Sunday week uses its own saved cleaning hours. Estimates add paid travel for
          proposed visits; review travel on assigned visits before confirming payroll.
        </p>
        {!weeklyPlan.some(w => w.employees.length) ? <p className="mt-3 text-sm text-ink-3">No employee hourly terms are on this roster. Contractor visit pay appears in the recommendations below.</p> :
          weeklyPlan.map(({ week, employees }) => <section key={week} className="mt-5" aria-label={`Week of ${formatCalendarDate(week)}`}>
            <h3 className="text-sm font-semibold text-ink">Week of {formatCalendarDate(week)} through {formatCalendarDate(addCalendarDays(week, 6))}</h3>
            <ul className="mt-2 divide-y divide-line-soft">
              {employees.map(({ cleaner, priorHours, proposedVisits, guaranteeLeft, forecast }) => <li key={cleaner.id} className="py-3">
                <p className="font-medium text-navy">{cleaner.name}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-2 text-sm sm:grid-cols-4">
                  <div><dt className="text-ink-3">Saved cleaning</dt><dd className="nums">{priorHours.toFixed(1)}h</dd></div>
                  <div><dt className="text-ink-3">Proposed visits</dt><dd className="nums">{proposedVisits}</dd></div>
                  <div><dt className="text-ink-3">Hours with plan</dt><dd className="nums">{forecast.totalHours.toFixed(1)}h</dd></div>
                  <div><dt className="text-ink-3">Guarantee left</dt><dd className="nums">{cleaner.terms?.guaranteedHoursPerWeek ? `${guaranteeLeft.toFixed(1)}h` : "No weekly guarantee"}</dd></div>
                </dl>
                <p className="mt-2 text-xs text-ink-3">{formatCents(forecast.weeklyCostCents)} estimated wage cost{forecast.overtimeHours > 0 ? ` · ${forecast.overtimeHours.toFixed(1)}h estimated overtime` : ""}</p>
              </li>)}
            </ul>
          </section>)}
      </section>

      <h2 className="mt-9 mb-3 text-sm font-semibold tracking-wide text-ink-2 uppercase">
        Jobs needing a cleaner
      </h2>
      {!board.length && (
        <p className="visit-feature">No recorded visits currently need matching. Check the full schedule for current assignments.</p>
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {board.map(({ job, decision }) => (
          <JobCard key={job.id} job={job} decision={decision} now={now} />
        ))}
      </ul>

      <h2 className="mt-10 mb-3 text-sm font-semibold tracking-wide text-ink-2 uppercase">
        Roster
      </h2>
      <div className="card overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line bg-surface-2">
              {["Cleaner", "Rating", "Accept", "Cleaning this week", "Guarantee left this week", "First visit check"].map((h) => (
                <th
                  key={h}
                  className="px-4 py-2.5 font-mono text-[10px] font-semibold tracking-wider text-ink-2 uppercase"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {currentRoster.map((c) => (
              <CleanerRow
                key={c.id}
                cleaner={c}
                unspent={residual.get(c.id) ?? 0}
                probe={board.find(e => e.decision.kind !== "needs_scheduling")?.job}
                eligibilityFor={context.eligibilityFor}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-3">Roster eligibility is checked against the next usable appointment in this plan. It does not confirm availability for every future visit.</p>
      <p className="mt-2 text-xs text-ink-3">
        The 3.9 rating floor and the background-check gate are enforced as a database constraint on
        the offers table, not in this page — no dispatch bug or manual override can route around
        them.
      </p>
    </>
  );
}
