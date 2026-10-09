"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCents } from "@/lib/money";
import { formatDateTimeInZone } from "@/lib/time/zone";
import {
  crewMessage,
  toCrewQuote,
  type CrewReview,
  type CrewReceipt,
  type CrewMember,
  type CrewAction,
} from "@/lib/crew/types";
import { crewResponse } from "@/lib/crew/response";

const receiptLabels: Record<CrewReceipt["state"], string> = {
  review: "Under review",
  sent: "Awaiting acceptance",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
  expired: "Expired",
  conflict: "No longer available",
};

function CrewList({
  crew,
  replacingLead = false,
}: {
  crew: CrewMember[];
  replacingLead?: boolean;
}) {
  return (
    <ul className="mt-3 divide-y divide-line">
      {crew.map((c) => (
        <li
          key={c.id}
          className="flex flex-wrap justify-between gap-2 py-3 text-sm"
        >
          <span>
            {c.name} ·{" "}
            {c.isLead
              ? replacingLead ? "Lead to replace" : "Lead"
              : replacingLead ? "Stays assigned" : "Teammate"}
          </span>
          <span className="font-semibold nums">
            {c.type === "w2_core"
              ? "Existing hourly terms"
              : `${formatCents(c.payoutCents)} agreed pay`}
          </span>
        </li>
      ))}
    </ul>
  );
}
export function ReplacementForm({
  jobId,
  data,
}: {
  jobId: string;
  data: CrewReview;
}) {
  const router = useRouter(),
    [candidate, setCandidate] = useState(""),
    [busy, setBusy] = useState(false),
    [quote, setQuote] = useState<ReturnType<typeof toCrewQuote> | null>(null),
    [saved, setSaved] = useState<CrewReceipt | null>(null),
    [error, setError] = useState(""),
    [signIn, setSignIn] = useState(false);
  const pending =
    saved?.state === "sent"
      ? saved
      : data.proposals.find((p) => p.state === "sent");
  const terminal = saved && saved.state !== "sent";
  const history = data.proposals.filter(
    (p) => p.state !== "review" && p.state !== "sent",
  );
  const currentReplacement = history.some(
    (p) => p.state === "accepted" && p.assignmentCurrent,
  );
  async function act(action: CrewAction) {
    setBusy(true);
    setError("");
    setSignIn(false);
    try {
      const res = await fetch("/api/admin/crew-replacement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (action.action === "quote" && res.status === 200) {
        const reviewed = toCrewQuote(payload);
        if (
          reviewed.jobId !== jobId ||
          reviewed.reviewCrew.length < 2 ||
          reviewed.reviewCrew.filter((c) => c.isLead).length !== 1
        )
          throw new Error();
        setQuote(reviewed);
        setSaved(null);
      } else {
        const result = crewResponse(
          res.status,
          payload,
          action.action === "quote" ? "" : action.id,
        );
        if (result.error) {
          setError(result.error);
          setSignIn(result.signIn ?? false);
        } else if (result.receipt) {
          if (result.receipt.jobId !== jobId) throw new Error();
          setSaved(result.receipt);
          setQuote(null);
          router.refresh();
        }
      }
    } catch {
      setError(
        "We could not confirm the save. Check your connection and retry the same action.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-6 max-w-2xl space-y-4">
      <section className="visit-feature">
        <h2 className="font-semibold text-navy">Current crew</h2>
        <p className="mt-2 text-sm">
          {formatDateTimeInZone(new Date(data.start))} ·{" "}
          {formatCents(data.clientPriceCents)} client price
        </p>
        <CrewList crew={data.crew} />
      </section>
      {error && (
        <p role="alert" className="rounded-lg border border-line p-4 text-sm">
          {error}
        </p>
      )}
      {signIn && (
        <Link
          href="/login?next=%2Fadmin%2Fcleaner-requests"
          className="secondary-action"
        >
          Sign in again
        </Link>
      )}
      {saved && (
        <p role="status" className="visit-feature text-sm">
          {crewMessage(saved)} No client charge was created.
        </p>
      )}
      {pending && !terminal && (
        <section className="visit-feature">
          <h2 className="font-semibold text-navy">
            Waiting for {pending.cleanerName}
          </h2>
          <p className="mt-2 text-sm">
            {formatCents(pending.payoutCents)} visit pay. Offer expires{" "}
            {formatDateTimeInZone(new Date(pending.expiresAt))}. The original
            crew stays assigned while they decide.
          </p>
          <button
            disabled={busy}
            className="secondary-action mt-4"
            onClick={() => void act({ action: "withdraw", id: pending.id })}
          >
            {busy ? "Saving…" : "Withdraw replacement offer"}
          </button>
        </section>
      )}
      {!pending && !terminal && data.canReplace && !quote && (
        <section className="visit-feature">
          <h2 className="font-semibold text-navy">Choose a replacement</h2>
          <p className="mt-2 text-sm text-ink-2">
            Only eligible cleaners outside this crew are listed. Availability is
            checked again before assignment.
          </p>
          {data.candidates.length ? (
            <>
              <label
                className="mt-4 block text-sm font-semibold"
                htmlFor="replacement-cleaner"
              >
                Replacement lead
              </label>
              <select
                id="replacement-cleaner"
                value={candidate}
                disabled={busy}
                onChange={(e) => setCandidate(e.target.value)}
                className="mt-2 min-h-11 w-full rounded-lg border border-line bg-white px-3"
              >
                <option value="">Choose a cleaner</option>
                {data.candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ·{" "}
                    {c.type === "w2_core" ? "Employee" : "Contractor"}
                  </option>
                ))}
              </select>
              <button
                disabled={busy || !candidate}
                className="primary-action mt-4 w-full"
                onClick={() =>
                  void act({ action: "quote", jobId, cleanerId: candidate })
                }
              >
                {busy ? "Reviewing…" : "Review replacement"}
              </button>
            </>
          ) : (
            <p className="mt-3 text-sm">
              No eligible replacement is available in the current records. Check
              working hours and scheduling with the office, then refresh.
            </p>
          )}
        </section>
      )}
      {quote && (
        <section className="visit-feature" aria-labelledby="replacement-review">
          <h2 id="replacement-review" className="font-semibold text-navy">
            Review replacement: {quote.cleanerName}
          </h2>
          <p className="mt-2 text-sm">
            {formatDateTimeInZone(new Date(quote.start))} ·{" "}
            {formatCents(quote.clientPriceCents)} client price
          </p>
          <CrewList crew={quote.reviewCrew} replacingLead />
          <p className="mt-3 text-sm font-semibold">
            {quote.type === "contractor_1099"
              ? `${formatCents(quote.payoutCents)} visit pay, requiring the contractor’s acceptance`
              : `${formatCents(quote.hourlyRateCents!)} hourly rate under existing payroll terms. No contractor visit fee.`}
          </p>
          <p className="mt-2 text-sm text-ink-2">
            The time, client price and teammates’ agreements stay unchanged.{" "}
            {quote.needsClientApproval
              ? "This new backup needs fresh client approval before anyone starts."
              : "This is the client’s requested cleaner."}{" "}
            This review expires{" "}
            {formatDateTimeInZone(new Date(quote.expiresAt))}.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              disabled={busy}
              className="primary-action"
              onClick={() => void act({ action: "confirm", id: quote.id })}
            >
              {busy
                ? "Saving…"
                : quote.type === "contractor_1099"
                  ? "Send replacement offer"
                  : "Assign employee as lead"}
            </button>
            <button
              disabled={busy}
              className="secondary-action"
              onClick={() => setQuote(null)}
            >
              Choose another cleaner
            </button>
          </div>
        </section>
      )}
      {history.length > 0 && (
        <section className="visit-feature" aria-labelledby="replacement-history">
          <h2 id="replacement-history" className="font-semibold text-navy">
            Replacement history
          </h2>
          <p className="mt-2 text-sm text-ink-2">
            Saved outcomes from the latest replacement reviews. An earlier
            acceptance does not confirm a current assignment.
          </p>
          <ul className="mt-3 divide-y divide-line">
            {history.map((receipt) => (
              <li key={receipt.id} className="space-y-2 py-4 text-sm">
                <h3 className="font-semibold text-navy">
                  {receipt.cleanerName} · {receiptLabels[receipt.state]}
                </h3>
                <p>
                  {receipt.type === "w2_core"
                    ? `${formatCents(receipt.hourlyRateCents!)} hourly rate under existing payroll terms`
                    : `${formatCents(receipt.payoutCents)} agreed visit pay`}
                  . Appointment: {formatDateTimeInZone(new Date(receipt.start))}.
                </p>
                <p>{crewMessage(receipt)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!data.canReplace && !saved && !currentReplacement && (
        <p className="visit-feature text-sm">
          The current visit does not have an unstarted crew with one
          client-declined lead. Review the latest visit and client decision.
        </p>
      )}
      <button
        disabled={busy}
        className="secondary-action"
        onClick={() => {
          setQuote(null);
          setSaved(null);
          router.refresh();
        }}
      >
        Refresh crew and offers
      </button>
    </div>
  );
}
