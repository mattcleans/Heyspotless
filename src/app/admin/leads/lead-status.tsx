"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Won, lost, spam.
 *
 * SETTING A STATUS ALSO STOPS THE CHASE. `set_lead_status` cancels whatever the
 * nudge queue is still holding for this lead, in the same statement — because
 * the alternative is two things to remember, and the one people forget is the
 * one that texts a customer who booked yesterday.
 *
 * There is no "quoted" button. A lead becomes quoted by somebody answering it,
 * which the inbox records on its own; a status somebody has to remember to set
 * is a status that is wrong by Wednesday.
 */

const CHOICES = [
  { value: "won", label: "Won", tone: "bg-good/15 text-good border-good/40" },
  { value: "lost", label: "Lost", tone: "bg-surface-2 text-ink-2 border-line" },
  { value: "spam", label: "Spam", tone: "bg-surface-2 text-ink-3 border-line" },
] as const;

export function LeadStatus({ leadId, status }: { leadId: string; status: string }) {
  const router = useRouter();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function set(next: string) {
    setWorking(next);
    setError(null);
    try {
      const response = await fetch("/api/leads/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId, status: next }),
      });
      if (!response.ok) {
        setError("That did not save.");
        return;
      }
      router.refresh();
    } catch {
      setError("No connection.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <>
      {CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          disabled={working !== null || status === choice.value}
          onClick={() => void set(choice.value)}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-100 ${
            status === choice.value ? choice.tone : "border-line bg-surface-2 text-ink-3 hover:border-sky-deep"
          }`}
        >
          {working === choice.value ? "…" : choice.label}
        </button>
      ))}
      {error ? <span className="text-xs text-bad">{error}</span> : null}
    </>
  );
}
