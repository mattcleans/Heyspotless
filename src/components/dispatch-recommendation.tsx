import { Pill } from "@/components/ui";
import type { DispatchDecision } from "@/lib/dispatch/engine";
import { formatCents, formatPct } from "@/lib/money";

/** A recalculated plan is not evidence that an offer or assignment was saved. */
export function DispatchRecommendation({ decision, priceCents, now }: {
  decision: DispatchDecision; priceCents: number; now: Date;
}) {
  const employee = decision.kind === "assign_guaranteed" || decision.kind === "assign_w2";
  const cost = employee
    ? decision.marginalCents
    : decision.kind === "hold_for_incumbent" || decision.kind === "open_board"
      ? decision.payoutCents : null;
  return (
    <>
      <h4 className="mb-2 text-sm font-semibold text-navy">Suggested next step</h4>
      {employee ? (
        <>
          <Pill tone="sky">Consider {decision.cleaner.name}</Pill>
          <p className="mt-2 text-sm text-ink-2">
            {decision.kind === "assign_guaranteed"
              ? "This visit is estimated to fit within guaranteed hours already paid for."
              : "Employee scheduling is suggested at the estimated additional cost below."}
            {" "}Employee wages follow their hourly terms; additional cost is not their pay.
          </p>
        </>
      ) : decision.kind === "hold_for_incumbent" ? (
        <>
          <Pill tone="sky">Offer to {decision.cleaner.name} first</Pill>
          <p className="mt-2 text-sm text-ink-2">
            {decision.basis === "preferred"
              ? "The client requested this cleaner."
              : "This cleaner has completed previous visits at this home."}
            {" "}Suggested exclusive response window: {Math.max(0, Math.round((decision.exclusiveUntil.getTime() - now.getTime()) / 60_000))} minutes
            after sending. A saved offer determines the actual deadline.
          </p>
          <p className="mt-1 text-xs text-ink-3">
            If not accepted, consider {decision.fallback === "waterfall" ? "timed offers to other eligible cleaners" : "an open offer to eligible cleaners"}.
          </p>
        </>
      ) : decision.kind === "open_board" ? (
        <>
          <Pill tone="sky">Consider an open offer</Pill>
          <p className="mt-2 text-sm text-ink-2">
            {decision.eligible.length} eligible cleaners in this plan. Review current availability before sending.
          </p>
        </>
      ) : decision.kind === "waterfall" ? (
        <>
          <Pill tone="warn">Consider timed offers</Pill>
          <p className="mt-2 text-sm text-ink-2">Proposed offer amounts, reviewed in order:</p>
          <ol className="mt-2 flex flex-wrap gap-2 text-sm">
            {decision.ladder.map(rung => (
              <li key={rung.index} className="nums rounded border border-line px-2 py-1">
                {formatCents(rung.payoutCents)}
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-ink-3">These amounts do not confirm that offers were sent or accepted.</p>
        </>
      ) : (
        <>
          <Pill tone="bad">No eligible cleaner in this plan</Pill>
          <p className="mt-2 text-sm text-ink-2">Review cleaner availability and requirements before offering this visit.</p>
        </>
      )}
      {cost !== null && priceCents > 0 && (
        <p className="mt-2 text-xs text-ink-3">
          Client price <span className="nums">{formatCents(priceCents)}</span> ·{" "}
          {employee ? "Estimated additional cost" : "Proposed contractor pay"}{" "}
          <span className="nums">{formatCents(cost)}</span> ·{" "}
          Estimated contribution <span className="nums">{formatCents(priceCents - cost)}</span>{" "}
          ({formatPct((priceCents - cost) / priceCents)})
        </p>
      )}
      {decision.continuity.status === "waived_too_costly" && (
        <p className="mt-2 text-sm text-ink-2">
          Consider a backup: the usual cleaner adds {formatCents(decision.continuity.premiumCents)}
          {" "}above the alternative, over the {formatCents(decision.continuity.capCents)} review limit.
          The client must approve the actual backup assignment before work starts.
        </p>
      )}
      {decision.continuity.status === "none" && decision.continuity.reason === "incumbent_ineligible" && (
        <p className="mt-2 text-sm text-ink-2">The usual cleaner did not meet this visit’s eligibility requirements. A backup needs the client’s approval before work starts.</p>
      )}
      {decision.continuity.status === "none" && decision.continuity.reason === "incumbent_passed" && (
        <p className="mt-2 text-sm text-ink-2">The usual cleaner declined or did not accept a previous offer. Review its saved status before offering to someone else.</p>
      )}
      {decision.continuity.status === "none" && decision.continuity.reason === "no_lead_time" && (
        <p className="mt-2 text-sm text-ink-2">The appointment is too close for the usual exclusive response window. Review the visit before offering it.</p>
      )}
    </>
  );
}
