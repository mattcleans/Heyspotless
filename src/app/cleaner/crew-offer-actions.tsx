"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { crewResponse } from "@/lib/crew/response";
import { crewMessage, type CrewReceipt } from "@/lib/crew/types";
export function CrewOfferActions({ offer }: { offer: CrewReceipt }) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState<CrewReceipt | null>(null),
    [error, setError] = useState(""),
    [signIn, setSignIn] = useState(false);
  async function answer(accept: boolean) {
    setBusy(true);
    setError("");
    setSignIn(false);
    try {
      const res = await fetch("/api/cleaner/crew-offers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: offer.id, accept }),
      });
      const result = crewResponse(
        res.status,
        await res.json().catch(() => null),
        offer.id,
      );
      if (result.error) {
        setError(result.error);
        setSignIn(result.signIn ?? false);
      } else if (result.receipt) {
        if (
          result.receipt.jobId !== offer.jobId ||
          (accept && result.receipt.state === "declined") ||
          (!accept && result.receipt.state === "accepted")
        )
          throw new Error();
        setSaved(result.receipt);
        router.refresh();
      }
    } catch {
      setError(
        "We could not confirm your answer. Check your connection and retry the same action.",
      );
    } finally {
      setBusy(false);
    }
  }
  const current = saved ?? offer;
  if (current.state !== "sent")
    return (
      <div className="mt-3 text-sm">
        <p role="status">{crewMessage(current)}</p>
        {current.state === "accepted" && (
          <Link
            href={`/cleaner/job/${current.jobId}`}
            className="secondary-action mt-3"
          >
            Check current visit
          </Link>
        )}
      </div>
    );
  return (
    <div className="mt-4">
      {error && (
        <p role="alert" className="mb-3 text-sm">
          {error}
        </p>
      )}
      {signIn && (
        <Link href="/login?next=%2Fcleaner" className="secondary-action mb-3">
          Sign in again
        </Link>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          disabled={busy}
          className="primary-action"
          onClick={() => void answer(true)}
        >
          {busy ? "Saving…" : "Accept lead offer"}
        </button>
        <button
          disabled={busy}
          className="secondary-action"
          onClick={() => void answer(false)}
        >
          Pass on offer
        </button>
      </div>
    </div>
  );
}
