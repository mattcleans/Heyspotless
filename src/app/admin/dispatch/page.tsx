import { PageHeader, Pill, Stat, Callout } from "@/components/ui";
import {
  AVERAGE_TICKET_CENTS,
  DEMO_CLEANERS,
  DEMO_JOBS,
  DEMO_NOW,
  ZIP_CENTROIDS,
  type DemoJob,
} from "@/lib/demo/fixtures";
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
import { SERVICE_LABELS, FREQUENCY_LABELS } from "@/lib/pricing/price-book";

export const metadata = { title: "Dispatch — Spotless Ops" };

const estimate = zipCentroidEstimator(ZIP_CENTROIDS);

const DISPATCH_CONTEXT = {
  now: DEMO_NOW,
  cleaners: DEMO_CLEANERS,
  driveFor: (c: Cleaner, j: DemoJob | { zip: string }) => estimate(c.lastStopZip, j.zip),
  // Deterministic so the demo board does not reshuffle on every render.
  rng: () => 0.5,
};

function DecisionSummary({ decision }: { decision: DispatchDecision }) {
  switch (decision.kind) {
    case "assign_guaranteed":
      return (
        <>
          <Pill tone="good">Guaranteed hours · $0 marginal</Pill>
          <p className="mt-2 text-sm text-ink-2">
            <strong className="text-ink">{decision.cleaner.name}</strong> — {decision.rationale}
          </p>
        </>
      );
    case "assign_w2":
      return (
        <>
          <Pill tone="sky">W-2 fallback · {formatCents(decision.marginalCents)}</Pill>
          <p className="mt-2 text-sm text-ink-2">{decision.rationale}</p>
        </>
      );
    case "open_board":
      return (
        <>
          <Pill tone="sky">Open board · {formatCents(decision.payoutCents)}</Pill>
          <p className="mt-2 text-sm text-ink-2">{decision.rationale}</p>
          <p className="mt-1 text-xs text-ink-3">
            Promotes to the waterfall{" "}
            {decision.promoteToWaterfallAt.toLocaleString("en-US", {
              weekday: "short",
              hour: "numeric",
              minute: "2-digit",
            })}{" "}
            · {decision.eligible.length} eligible
          </p>
        </>
      );
    case "waterfall":
      return (
        <>
          <Pill tone="warn">
            Waterfall · {decision.ladder.length} rung{decision.ladder.length === 1 ? "" : "s"}
          </Pill>
          <p className="mt-2 text-sm text-ink-2">{decision.rationale}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {decision.ladder.map((rung) => (
              <span
                key={rung.index}
                className="nums rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2"
                title={`${formatCents(rung.hourlyRateCents)}/hr · ${formatPct(rung.payoutPct)} of ticket · at +${Math.round(rung.offerAtSeconds / 60)}m`}
              >
                {formatCents(rung.payoutCents)}
              </span>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-ink-3">
            Cleaners see one offer at a time with a countdown — never the ladder.
          </p>
        </>
      );
    case "no_eligible_cleaner":
      return (
        <>
          <Pill tone="bad">No eligible cleaner</Pill>
          <p className="mt-2 text-sm text-ink-2">{decision.rationale}</p>
        </>
      );
  }
}

function JobCard({ job, decision }: { job: DemoJob; decision: DispatchDecision }) {
  const hours = hoursUntil(job, DEMO_NOW);

  return (
    <li className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-semibold text-ink">{job.customerName}</h3>
        <span className="nums text-sm text-navy">{formatCents(job.priceCents)}</span>
      </div>
      <p className="mt-0.5 text-sm text-ink-3">
        {job.street}, {job.city} · {job.bedrooms}bd/{job.bathrooms}ba
      </p>
      <p className="mt-1.5 text-xs text-ink-3">
        {SERVICE_LABELS[job.service]} · {FREQUENCY_LABELS[job.frequency]} ·{" "}
        {formatHours(job.estimatedCleanMinutes)} ·{" "}
        {job.scheduledStart
          ? Number.isFinite(hours)
            ? `in ${Math.round(hours)}h`
            : "unscheduled"
          : "unscheduled"}
      </p>
      <div className="mt-3.5 border-t border-line-soft pt-3.5">
        <DecisionSummary decision={decision} />
      </div>
    </li>
  );
}

function CleanerRow({ cleaner, unspent }: { cleaner: Cleaner; unspent: number }) {
  // Show why an ineligible cleaner is invisible to dispatch, using a
  // representative job so the reason is concrete.
  const probe = DEMO_JOBS[0]!;
  const eligibility = checkEligibility(cleaner, probe);

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

export default function DispatchPage() {
  const shonda = DEMO_CLEANERS.find((c) => c.id === "shonda")!;

  // Plan the whole board at once. Deciding each job independently would tell
  // every job the same guaranteed hours are free, and six jobs would each claim
  // the same 8.5 unspent hours. Capacity is consumed as it is allocated.
  const board = dispatchBoard(DEMO_JOBS, DISPATCH_CONTEXT);
  const residual = residualGuaranteedHours(board, DISPATCH_CONTEXT);

  // Hours still unspent AFTER this board is allocated — the honest figure.
  const idleHours = residual.get(shonda.id) ?? 0;
  const idleCents = unspentGuaranteedCents({
    ...shonda,
    hoursScheduledThisWeek: (shonda.terms?.guaranteedHoursPerWeek ?? 0) - idleHours,
  });

  // What the week looks like if every unassigned job lands on Shonda.
  const assignedToShonda = board.filter(
    (e) =>
      (e.decision.kind === "assign_guaranteed" || e.decision.kind === "assign_w2") &&
      e.decision.cleaner.id === shonda.id,
  );
  const forecast = forecastWeek(
    shonda,
    assignedToShonda.map((e) => ({
      cleanMinutes: e.job.estimatedCleanMinutes,
      driveMinutes: DISPATCH_CONTEXT.driveFor(shonda, e.job).minutes,
    })),
    AVERAGE_TICKET_CENTS,
    shonda.hoursScheduledThisWeek * 60, // already on her schedule
  );

  const needMarket = board.filter(
    (e) => e.decision.kind === "waterfall" || e.decision.kind === "open_board",
  ).length;

  return (
    <>
      <PageHeader eyebrow="Admin" title="Dispatch board">
        Every job runs the same path: spend guaranteed hours first, then the eligibility gate, then
        the board or the waterfall. Each card shows what the engine decided and why.
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Unfilled guaranteed hrs"
          value={`${idleHours.toFixed(1)}h`}
          note={`${formatCents(idleCents)} already spent, currently earning nothing`}
          tone={idleHours > 0 ? "warn" : "good"}
        />
        <Stat label="Jobs needing a cleaner" value={String(DEMO_JOBS.length)} />
        <Stat
          label="Going to market"
          value={String(needMarket)}
          note="Board or waterfall — not covered by guaranteed hours"
        />
        <Stat
          label="Forecast week"
          value={`${forecast.totalHours.toFixed(1)}h`}
          note={`${forecast.overtimeHours.toFixed(1)}h overtime · ${formatCents(forecast.weeklyCostCents)}`}
          tone={forecast.overtimeHours > 0 ? "warn" : "good"}
        />
      </div>

      {idleHours > 0 ? (
        <div className="mt-4">
          <Callout tone="warn" label="Idle guaranteed hours">
            Shonda has <strong>{idleHours.toFixed(1)} unfilled guaranteed hours</strong> this week —{" "}
            {formatCents(idleCents)} already committed to payroll and currently earning nothing.
            Fill these before any job goes to the marketplace.
          </Callout>
        </div>
      ) : null}

      {forecast.overtimeHours > 0 ? (
        <div className="mt-3">
          <Callout tone="bad" label="Overtime before you commit the week">
            This schedule is {forecast.totalHours.toFixed(1)} hours, not 40 — it carries{" "}
            <strong>{forecast.overtimeHours.toFixed(1)} hours of overtime</strong> at time and a
            half, costing {formatCents(forecast.weeklyCostCents)} rather than $805.00. Still the
            cheapest labor available, but the week should be built knowing it.
          </Callout>
        </div>
      ) : null}

      <h2 className="mt-9 mb-3 text-sm font-semibold tracking-wide text-ink-2 uppercase">
        Jobs needing a cleaner
      </h2>
      <ul className="grid gap-3 md:grid-cols-2">
        {board.map(({ job, decision }) => (
          <JobCard key={job.id} job={job} decision={decision} />
        ))}
      </ul>

      <h2 className="mt-10 mb-3 text-sm font-semibold tracking-wide text-ink-2 uppercase">
        Roster
      </h2>
      <div className="card overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line bg-surface-2">
              {["Cleaner", "Rating", "Accept", "Booked", "Unspent gtd", "Gate"].map((h) => (
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
            {DEMO_CLEANERS.map((c) => (
              <CleanerRow key={c.id} cleaner={c} unspent={residual.get(c.id) ?? 0} />
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
