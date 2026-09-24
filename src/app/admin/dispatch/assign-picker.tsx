"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface PickerOption {
  id: string;
  label: string;
  /** Why this cleaner can't take the job; absent when they can. */
  blockedBy?: string;
}

const POOL = "";

/**
 * Assign a cleaner to one job.
 *
 * Preselects the default (Shonda, then Ignis, then the contractor pool). The
 * pool is not an assignment: leaving it selected means the dispatch sweep
 * offers the job to contractors, so the button is disabled on it.
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

  async function assign() {
    setWorking(true);
    setError(null);
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
          {working ? "Assigning…" : "Assign"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
