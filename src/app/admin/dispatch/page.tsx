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
} from "@/lib/dispatch/engine";
import { unspentGuaranteedCents } from "@/lib/dispatch/marginal-cost";
import { forecastWeek, zipCentroidEstimator } from "@/lib/dispatch/route";
import { checkEligibility, REASON_LABELS } from "@/lib/dispatch/eligibility";
import type { Cleaner } from "@/lib/dispatch/types";
import { formatCents, formatHours, formatPct } from "@/lib/money";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { SERVICE_LABELS, FREQUENCY_LABELS } from "@/lib/pricing/price-book";

export const metadata = { title: "Matching plan | Hey Spotless management" };

const estimate = zipCentroidEstimator(ZIP_CENTROIDS);

function buildContext(cleaners: Cleaner[], now: Date) {
  return {
    now,
    cleaners,
    driveFor: (c: Cleaner, j: { zip: string }) => estimate(c.lastStopZip, j.zip),
    // Deterministic so the board does not reshuffle between renders.
    rng: () => 0.5,
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
}: {
  cleaner: Cleaner;
  unspent: number;
  probe: Job | undefined;
}) {
  // Show why an ineligible cleaner is invisible to dispatch, using a real job so
  // the reason is concrete rather than hypothetical.
  const eligibility = probe
    ? checkEligibility(cleaner, probe)
    : { eligible: true, reasons: [] as const };

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
        {eligibility.eligible ? (
          <Pill tone="good">Eligible</Pill>
        ) : (
          <span title={eligibility.reasons.map((r) => REASON_LABELS[r]).join(" · ")}>
            <Pill tone="bad">{REASON_LABELS[eligibility.reasons[0]!]}</Pill>
          </span>
        )}
      </td>
    </tr>
  );
}

export default async function DispatchPage() {
  const repo = await getRepository();
  const [jobs, cleaners] = await Promise.all([
    repo.listJobs({ needingCleaner: true }),
    repo.listCleaners(),
  ]);

  const now = new Date();
  const context = buildContext(cleaners, now);

  // Plan the whole board at once. Deciding each job independently would tell
  // every job the same guaranteed hours are free, and six jobs would each claim
  // the same unspent hours. Capacity is consumed as it is allocated.
  const board = dispatchBoard(jobs, context);
  const residual = residualGuaranteedHours(board, context);

  // The cleaner with a weekly guarantee is the one whose idle hours cost money.
  const guaranteed = cleaners.find((c) => (c.terms?.guaranteedHoursPerWeek ?? 0) > 0);

  const idleHours = guaranteed ? (residual.get(guaranteed.id) ?? 0) : 0;
  const idleCents = guaranteed
    ? unspentGuaranteedCents({
        ...guaranteed,
        hoursScheduledThisWeek: (guaranteed.terms?.guaranteedHoursPerWeek ?? 0) - idleHours,
      })
    : 0;

  // What the week looks like if every unassigned job lands on Shonda.
  const assignedToGuaranteed = guaranteed
    ? board.filter(
        (e) =>
          (e.decision.kind === "assign_guaranteed" || e.decision.kind === "assign_w2") &&
          e.decision.cleaner.id === guaranteed.id,
      )
    : [];

  const forecast = guaranteed
    ? forecastWeek(
        guaranteed,
        assignedToGuaranteed.map((e) => ({
          cleanMinutes: e.job.estimatedCleanMinutes,
          driveMinutes: context.driveFor(guaranteed, e.job).minutes,
        })),
        AVERAGE_TICKET_CENTS,
        guaranteed.hoursScheduledThisWeek * 60, // already on the schedule
      )
    : null;

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

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Guarantee left after plan"
          value={`${idleHours.toFixed(1)}h`}
          note={`${formatCents(idleCents)} estimated unallocated payroll after these recommendations`}
          tone={idleHours > 0 ? "warn" : "good"}
        />
        <Stat label="Jobs needing a cleaner" value={String(jobs.length)} />
        <Stat
          label="Suggested contractor offers"
          value={String(needMarket)}
          note="Proposed open offers or timed offers; not confirmation that they were sent"
        />
        <Stat
          label="Estimated week with plan"
          value={forecast ? `${forecast.totalHours.toFixed(1)}h` : "—"}
          note={
            forecast
              ? `${forecast.overtimeHours.toFixed(1)}h overtime · ${formatCents(forecast.weeklyCostCents)}`
              : "No cleaner on guaranteed hours"
          }
          tone={forecast && forecast.overtimeHours > 0 ? "warn" : "good"}
        />
      </div>

      {guaranteed && idleHours > 0 ? (
        <div className="mt-4">
          <Callout tone="warn" label="Hours left after these recommendations">
            If this plan is used, {guaranteed.name} would have{" "}
            <strong>{idleHours.toFixed(1)} guaranteed hours</strong> left to fill this week.
            Review availability and saved assignments before scheduling more work.
          </Callout>
        </div>
      ) : null}

      {forecast && forecast.overtimeHours > 0 ? (
        <div className="mt-3">
          <Callout tone="bad" label="Estimated overtime with this plan">
            These recommendations would bring the week to {forecast.totalHours.toFixed(1)} hours,
            including <strong>{forecast.overtimeHours.toFixed(1)} overtime hours</strong>.
            Estimated weekly cost: {formatCents(forecast.weeklyCostCents)}.
            Review the saved schedule before committing more work.
          </Callout>
        </div>
      ) : null}

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
              {["Cleaner", "Rating", "Accept", "Booked", "Left after plan", "First visit check"].map((h) => (
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
            {cleaners.map((c) => (
              <CleanerRow
                key={c.id}
                cleaner={c}
                unspent={residual.get(c.id) ?? 0}
                probe={jobs[0]}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-3">
        The 3.9 rating floor and the background-check gate are enforced as a database constraint on
        the offers table, not in this page — no dispatch bug or manual override can route around
        them.
      </p>
    </>
  );
}
