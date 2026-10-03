"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { checkedCancellationReceipt } from "@/lib/customer/cancellation/types";
export function ResolveCancellationForm({
  jobId,
  cancellationId,
}: {
  jobId: string;
  cancellationId: string;
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [error, setError] = useState(""),
    [signIn, setSignIn] = useState(false);
  async function resolve() {
    if (busy || saved) return;
    setBusy(true);
    setError("");
    setSignIn(false);
    try {
      const r = await fetch(`/api/admin/visits/${jobId}/resolve-cancellation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cancellationId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setSignIn(r.status === 401);
        throw new Error(data.error ?? "Billing review could not be saved.");
      }
      const receipt = checkedCancellationReceipt(data.receipt);
      if (
        data.resolved !== true ||
        receipt.jobId !== jobId ||
        receipt.id !== cancellationId ||
        receipt.billingReview
      )
        throw new Error(
          "Billing review could not be confirmed. Retry or refresh the records.",
        );
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Billing review could not be confirmed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3">
      <p className="text-sm text-ink-2">
        After existing payments are fully refunded and all provider attempts or
        refunds are resolved, recheck to record the fee invoice. This action
        does not send a refund or charge a card.
      </p>
      <button
        className="secondary-action mt-3 min-h-11"
        disabled={busy || saved}
        onClick={resolve}
      >
        {saved
          ? "Billing review resolved"
          : busy
            ? "Rechecking payments…"
            : "Recheck payments and settle cancellation"}
      </button>
      {error && (
        <p className="mt-3 text-sm text-bad" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="mt-3 text-sm">
          Cancellation billing resolved. Refresh the visit to see the current
          invoice.
        </p>
      )}
      {signIn && (
        <Link
          href="/login?next=%2Fadmin%2Fcancellations"
          className="inline-flex min-h-11 items-center underline"
        >
          Sign in again
        </Link>
      )}
    </div>
  );
}
