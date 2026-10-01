"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { formatDateTimeInZone } from "@/lib/time/zone";
import type {
  CancellationQuote,
  CancellationReceipt,
  CancellationReason,
} from "@/lib/customer/cancellation/types";
import {
  checkedCancellationQuote,
  checkedCancellationReceipt,
} from "@/lib/customer/cancellation/types";
export function CancellationReceiptDetails({
  receipt,
}: {
  receipt: CancellationReceipt;
}) {
  return (
    <section className="visit-feature mt-5" role="status">
      <h2 className="text-lg font-semibold text-navy">
        {receipt.reason === "skip"
          ? "This visit is skipped"
          : "This visit is canceled"}
      </h2>
      <p className="mt-2 text-sm">
        {receipt.feeCents
          ? `${formatCents(receipt.feeCents)} cancellation fee recorded.`
          : "No cancellation fee."}
      </p>
      <p className="mt-2 text-sm text-ink-2">
        {receipt.billingReview
          ? "The office needs to reconcile an existing payment or payment attempt before settling the balance. This cancellation did not start another payment."
          : receipt.feeCents
            ? "The fee is on your account. If you have authorized autopay, it follows your existing payment settings."
            : "This confirmation did not start a payment."}
      </p>
      <p className="mt-2 text-sm text-ink-2">
        This does not change your recurring schedule.
      </p>
      {receipt.feeCents > 0 && (
        <Link
          href="/customer/account"
          className="secondary-action mt-4 inline-flex"
        >
          View account balance
        </Link>
      )}
    </section>
  );
}
export function VisitCancellationForm({
  jobId,
  recurring,
  closed = false,
  receipt: initialReceipt = null,
  office = false,
  preview = false,
  initialReason = "cancel",
}: {
  jobId: string;
  recurring: boolean;
  closed?: boolean;
  receipt?: CancellationReceipt | null;
  office?: boolean;
  preview?: boolean;
  initialReason?: CancellationReason;
}) {
  const router = useRouter(),
    [reason, setReason] = useState<CancellationReason>(initialReason),
    [quote, setQuote] = useState<CancellationQuote | null>(null),
    [receipt, setReceipt] = useState(initialReceipt),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [signIn, setSignIn] = useState(false),
    [stale, setStale] = useState(false);
  const base = office ? "admin" : "customer",
    back = `/${base}/visits/${jobId}`;
  async function submit(action: "review" | "confirm") {
    if (busy || preview || (action === "confirm" && (!quote || !ack || stale)))
      return;
    setBusy(true);
    setError("");
    setSignIn(false);
    try {
      const r = await fetch(`/api/${base}/visits/${jobId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action === "review"
            ? { action, reason }
            : { action, quoteId: quote!.id },
        ),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setSignIn(r.status === 401);
        if (r.status === 409) {
          setStale(true);
          router.refresh();
        }
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "We could not confirm the cancellation. Try again or call the office.",
        );
      }
      if (action === "review") {
        const reviewed = checkedCancellationQuote(data.quote);
        if (reviewed.jobId !== jobId || reviewed.reason !== reason)
          throw new Error(
            "The fee could not be confirmed. Review again before canceling.",
          );
        setQuote(reviewed);
        setAck(false);
        setStale(false);
      } else {
        const saved = checkedCancellationReceipt(data.receipt);
        if (
          data.canceled !== true ||
          saved.id !== quote!.id ||
          saved.jobId !== jobId ||
          saved.reason !== quote!.reason ||
          saved.feeCents !== quote!.feeCents
        )
          throw new Error(
            "We could not confirm the cancellation. Retry to check the saved result, or call the office.",
          );
        setReceipt(saved);
        router.refresh();
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "We could not confirm the cancellation. Try again or call the office.",
      );
    } finally {
      setBusy(false);
    }
  }
  const savedReceipt = receipt ?? initialReceipt;
  if (savedReceipt)
    return office ? (
      <section className="visit-feature mt-5" role="status">
        <h2 className="font-semibold">Cancellation recorded</h2>
        <p className="mt-2">
          Fee: {formatCents(savedReceipt.feeCents)}.{" "}
          {savedReceipt.billingReview
            ? "Reconcile existing payments before collecting the cancellation fee."
            : "No billing reconciliation flagged."}
        </p>
        <Link
          href="/admin/cancellations"
          className="secondary-action mt-4 inline-flex"
        >
          Review cancellation records
        </Link>
      </section>
    ) : (
      <CancellationReceiptDetails receipt={savedReceipt} />
    );
  if (closed)
    return (
      <p className="visit-feature mt-5">
        This visit has already started or closed. Call the office if you need
        help.
      </p>
    );
  return (
    <section className="card mt-5 p-5">
      <h2 className="text-lg font-semibold text-navy">
        {quote
          ? "Review cancellation"
          : office
            ? "Cancel or record a turnaway"
            : recurring
              ? "Cancel or skip this visit"
              : "Cancel this visit"}
      </h2>
      {!quote && (
        <p className="mt-2 text-sm text-ink-2">
          Cancellations on the appointment day and door turnaways have a $60
          fee. Canceling before the appointment day is free, including the
          previous evening. The appointment day uses Dallas time.
        </p>
      )}
      <p className="mt-2 text-sm text-ink-2">
        This affects only this visit. Your recurring schedule stays the same.
      </p>
      {preview && (
        <p className="preview-note mt-4 rounded-lg">
          Preview only. Sign in to cancel a real visit.
        </p>
      )}
      {!quote ? (
        <>
          {recurring || office ? (
            <label className="mt-4 block text-sm font-medium">
              What would you like to do?
              <select
                disabled={busy || preview}
                className="mt-2 min-h-11 w-full rounded-lg border border-line bg-white p-3"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value as CancellationReason);
                  setError("");
                  setStale(false);
                }}
              >
                <option value="cancel">Cancel this visit</option>
                {recurring && (
                  <option value="skip">Skip only this recurring visit</option>
                )}
                {office && (
                  <option value="door_turnaway">Record a door turnaway</option>
                )}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className="secondary-action mt-4 min-h-11 w-full"
            disabled={busy || preview}
            onClick={() => submit("review")}
          >
            {busy ? "Checking fee…" : "Review cancellation and fee"}
          </button>
        </>
      ) : (
        <div className="mt-4 border-t border-line pt-4">
          <p className="font-semibold text-navy">
            {quote.reason === "skip"
              ? "Skip this visit"
              : quote.reason === "door_turnaway"
                ? "Record door turnaway"
                : "Cancel this visit"}
          </p>
          <p className="mt-2 text-sm">
            {quote.scheduledStart
              ? formatDateTimeInZone(new Date(quote.scheduledStart))
              : "Time to be confirmed"}
          </p>
          <p className="mt-3 text-lg font-semibold">
            Cancellation fee: {formatCents(quote.feeCents)}
          </p>
          <p className="mt-2 text-sm text-ink-2">
            {quote.feeCents
              ? `This fee will be recorded on ${office ? "the client’s" : "your"} account. Existing payments may require office reconciliation.`
              : "No cancellation fee applies to this review."}{" "}
            Confirmation cancels the appointment immediately.
          </p>
          <label className="mt-4 flex min-h-11 items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={ack}
              disabled={busy || stale || preview}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-1 h-5 w-5 shrink-0"
            />
            <span>
              {office
                ? "I confirm this cancellation and its fee."
                : `I want to ${quote.reason === "skip" ? "skip" : "cancel"} this visit${quote.feeCents ? " and accept the $60 fee" : " with no fee"}.`}
            </span>
          </label>
          <button
            type="button"
            disabled={busy || !ack || stale || preview}
            onClick={() => submit("confirm")}
            className="primary-action mt-3 min-h-11 w-full"
          >
            {busy
              ? "Confirming…"
              : `${quote.reason === "skip" ? "Confirm skip" : quote.reason === "door_turnaway" ? "Record turnaway" : "Confirm cancellation"} · ${quote.feeCents ? "$60 fee" : "free"}`}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setQuote(null);
              setAck(false);
              setError("");
              setStale(false);
            }}
            className="mt-2 flex min-h-11 w-full items-center justify-center text-sm underline"
          >
            {stale ? "Review the current visit and fee" : "Change my choice"}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-bad">
          {error}
        </p>
      )}
      {signIn && (
        <Link
          href={`/login?next=${encodeURIComponent(back + "/cancel?choice=" + reason)}`}
          className="mt-3 inline-flex min-h-11 items-center underline"
        >
          Sign in again
        </Link>
      )}
      <Link
        href={back}
        className="mt-3 flex min-h-11 items-center justify-center text-sm underline"
      >
        Keep this visit and go back
      </Link>
    </section>
  );
}
