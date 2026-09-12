import { PageHeader, Pill, Stat, Callout } from "@/components/ui";
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

export const metadata = { title: "Dispatch — Spotless Ops" };

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
            {formatDateTimeInZone(decision.promoteToWaterfallAt)}{" "}
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
    case "hold_for_incumbent":
      return (
        <>
          <Pill tone="good">
            Held for {decision.cleaner.name} · {formatCents(decision.payoutCents)}
          </Pill>
          <p className="mt-2 text-sm text-ink-2">{decision.rationale}</p>
          <p className="mt-1 text-xs text-ink-3">
            Exclusive until {formatDateTimeInZone(decision.exclusiveUntil)} · then the{" "}
            {decision.fallback === "waterfall" ? "waterfall" : "open board"}
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

/**
 * What happened to the continuity promise, shown on every job including the
 * ones where nothing did.
 *
 * The two lines worth a manager's attention are the ones that are easy to
 * miss: a customer whose cleaner has lapsed a requirement and is about to meet
 * a stranger, and a customer we let go to market to save money. Both look like
 * an ordinary board posting without this.
 */
function ContinuityNote({ decision }: { decision: DispatchDecision }) {
  const c = decision.continuity;

  if (c.status === "waived_too_costly") {
    return (
      <p className="mt-2 text-xs text-ink-3">
        <Pill tone="warn">Substituting</Pill>{" "}
        Their usual cleaner would have cost {formatCents(c.premiumCents)} more than the
        alternative, over the {formatCents(c.capCents)} limit for this job.
      </p>
    );
  }

  if (c.status === "none" && c.reason === "incumbent_ineligible") {
    return (
      <p className="mt-2 text-xs text-ink-3">
        <Pill tone="bad">Lost their cleaner</Pill>{" "}
        This customer&apos;s cleaner did not clear the eligibility gate for this visit.
      </p>
    );
  }

  if (c.status === "none" && c.reason === "no_lead_time") {
    return (
      <p className="mt-2 text-xs text-ink-3">
        <Pill tone="warn">No hold</Pill> Too close to the visit to wait on one answer.
      </p>
    );
  }

  return null;
}

function JobCard({ job, decision, now }: { job: Job; decision: DispatchDecision; now: Date }) {
  const hours = hoursUntil(job, now);

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
        <ContinuityNote decision={decision} />
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
        <Stat label="Jobs needing a cleaner" value={String(jobs.length)} />
        <Stat
          label="Going to market"
          value={String(needMarket)}
          note="Board or waterfall — not covered by guaranteed hours"
        />
        <Stat
          label="Forecast week"
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
          <Callout tone="warn" label="Idle guaranteed hours">
            {guaranteed.name} has <strong>{idleHours.toFixed(1)} unfilled guaranteed hours</strong>{" "}
            this week —{" "}
            {formatCents(idleCents)} already committed to payroll and currently earning nothing.
            Fill these before any job goes to the marketplace.
          </Callout>
        </div>
      ) : null}

      {forecast && forecast.overtimeHours > 0 ? (
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
