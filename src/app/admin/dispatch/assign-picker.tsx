"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface PickerOption {
  id: string;
  label: string;
  /** Employees are assigned; contractors are offered the job and must accept. */
  kind: "assign" | "offer";
  /** Why this cleaner can't take the job; absent when they can. */
  blockedBy?: string;
}

const POOL = "";

/**
 * Assign a cleaner to one job, or offer it to a contractor.
 *
 * Preselects the default (Shonda, then Ignis, then the contractor pool). The
 * pool is not an assignment: leaving it selected means the dispatch sweep
 * offers the job to contractors, so the button is disabled on it.
 *
 * Picking a contractor sends her an offer rather than assigning her. She is on
 * the job only once she accepts it.
 */
export function AssignPicker({
  jobId,
  options,
  defaultCleanerId,
}: {
  jobId: string;
  options: PickerOption[];
  defaultCleanerId: string | null;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(defaultCleanerId ?? POOL);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const kind = options.find((o) => o.id === choice)?.kind ?? "assign";

  async function assign() {
    setWorking(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/dispatch/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, cleanerId: choice }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = (payload as { error?: unknown }).error;
        setError(typeof message === "string" ? message : "That did not save.");
        return;
      }
      const message = (payload as { message?: unknown }).message;
      if (typeof message === "string") setNote(message);
      router.refresh();
    } catch {
      setError("No connection.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="mt-3.5 border-t border-line-soft pt-3.5">
      <label className="eyebrow" htmlFor={`assign-${jobId}`}>
        Assign a cleaner
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          id={`assign-${jobId}`}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          disabled={working}
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
        >
          <option value={POOL}>Contractor pool (offer it automatically)</option>
          {options.map((o) => (
            <option key={o.id} value={o.id} disabled={Boolean(o.blockedBy)}>
              {o.label}
              {o.blockedBy ? ` (${o.blockedBy})` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={assign}
          disabled={working || choice === POOL}
          className="rounded-lg bg-navy px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-navy-deep disabled:opacity-50"
        >
          {working
            ? kind === "offer"
              ? "Sending…"
              : "Assigning…"
            : kind === "offer"
              ? "Send offer"
              : "Assign"}
        </button>
      </div>
      {kind === "offer" && choice !== POOL ? (
        <p className="mt-1.5 text-xs text-ink-3">
          Contractors get an offer to accept. They&apos;re only on the job once they say yes.
        </p>
      ) : null}
      {note ? <p className="mt-1.5 text-xs text-ink-2">{note}</p> : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
