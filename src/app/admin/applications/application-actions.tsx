"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The buttons that move somebody through hiring.
 *
 * ONLY THE LEGAL NEXT STEP IS SHOWN. The state machine is enforced in SQL, so
 * showing every button and letting the server refuse would work — it would just
 * teach whoever uses this screen that half the buttons do nothing, which is how
 * people stop reading error messages.
 *
 * Activation asks for the insurance expiry date when there is not one on file,
 * because a contractor cannot be activated without it and the gate compares
 * that date against every job. Asking here beats an error that says so.
 */

const NEXT: Record<string, { status: string; label: string }[]> = {
  submitted: [
    { status: "screened", label: "Screened" },
    { status: "background_pending", label: "Send for check" },
  ],
  screened: [{ status: "background_pending", label: "Send for check" }],
  background_pending: [{ status: "background_cleared", label: "Check cleared" }],
  background_cleared: [],
};

export function ApplicationActions({
  id,
  status,
  hasInsuranceDate,
}: {
  id: string;
  status: string;
  hasInsuranceDate: boolean;
}) {
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [insuranceDate, setInsuranceDate] = useState("");

  async function post(url: string, body: Record<string, unknown>) {
    setWorking(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      const data = (payload ?? {}) as { error?: unknown; note?: unknown };

      if (!response.ok) {
        setError(typeof data.error === "string" ? data.error : "That did not save.");
        return;
      }
      if (typeof data.note === "string") setNote(data.note);
      router.refresh();
    } catch {
      setError("No connection.");
    } finally {
      setWorking(false);
    }
  }

  const steps = NEXT[status] ?? [];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {steps.map((step) => (
          <button
            key={step.status}
            type="button"
            disabled={working}
            onClick={() => void post("/api/applications/advance", { status: step.status })}
            className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-2 hover:border-sky-deep disabled:opacity-50"
          >
            {step.label}
          </button>
        ))}

        {status === "background_cleared" ? (
          <>
            {!hasInsuranceDate ? (
              <input
                type="date"
                value={insuranceDate}
                onChange={(e) => setInsuranceDate(e.target.value)}
                aria-label="Insurance expires on"
                className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-xs"
              />
            ) : null}
            <button
              type="button"
              disabled={working || (!hasInsuranceDate && !insuranceDate)}
              onClick={() =>
                void post("/api/applications/activate", {
                  type: "contractor_1099",
                  insuranceExpiresOn: insuranceDate || null,
                })
              }
              className="rounded-lg bg-navy px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              Activate as contractor
            </button>
          </>
        ) : null}

        {status !== "activated" ? (
          <button
            type="button"
            disabled={working}
            onClick={() => setRejecting((r) => !r)}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-3 hover:border-bad"
          >
            Reject
          </button>
        ) : null}
      </div>

      {rejecting ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why — this is kept"
            className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs"
          />
          <button
            type="button"
            disabled={working || !reason.trim()}
            onClick={() =>
              void post("/api/applications/advance", { status: "rejected", reason: reason.trim() })
            }
            className="rounded-lg border border-bad px-3 py-1.5 text-xs font-medium text-bad disabled:opacity-40"
          >
            Confirm
          </button>
          {/*
            Rejection is final: a mistake becomes a new application rather than
            an edited one, so the record of what happened stays honest.
          */}
          <span className="text-[11px] text-ink-3">Cannot be undone.</span>
        </div>
      ) : null}

      {note ? <p className="text-xs text-good">{note}</p> : null}
      {error ? <p className="text-xs text-bad">{error}</p> : null}
    </div>
  );
}
