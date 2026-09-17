"use client";

import { useState } from "react";
import { JobCapture } from "../../job-capture";
import { Pill } from "@/components/ui";
import type { Room } from "@/lib/service/rooms";

/**
 * One job, from arriving to done.
 *
 * Three states, and the screen only ever shows the one she is in — a cleaner
 * standing in a doorway with a phone in one hand does not want a form, she
 * wants the next button.
 *
 *   assigned     → Start
 *   in_progress  → the room list, then Done
 *   complete     → what is still uploading, and nothing to press
 *
 * DONE IS NEVER BLOCKED. If photos are outstanding she is told, but the button
 * works: she has left, the house is clean, and the queue will keep uploading
 * whether or not this screen is open.
 */

type Status = "assigned" | "in_progress" | "complete";

export interface JobFlowProps {
  jobId: string;
  initialStatus: Status;
  rooms: Room[];
  alreadyDone: { roomKey: string; kind: string }[];
}

export function JobFlow({ jobId, initialStatus, rooms, alreadyDone }: JobFlowProps) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [outstanding, setOutstanding] = useState<{ label: string; missing: string[] }[]>([]);
  const [onMyWay, setOnMyWay] = useState<"idle" | "sending" | "sent">("idle");

  /**
   * Tell the customer she is coming.
   *
   * Separate from Start, and BEFORE it, because they are different moments:
   * on-my-way happens in the van and starting happens at the door. Folding
   * them together would either text the customer when the cleaner is already
   * on the step, or start the clock while she is still driving.
   *
   * One per job — the server enforces it — so this becomes a flat "Told them"
   * rather than a button that can be leaned on.
   */
  async function tellThem() {
    setOnMyWay("sending");
    setNote(null);
    try {
      const response = await fetch("/api/jobs/on-my-way", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      const data = (payload ?? {}) as { sent?: unknown; reason?: unknown };

      if (data.sent === true) {
        setOnMyWay("sent");
        return;
      }

      // A reason the customer could not be texted is hers to know: she is about
      // to knock on a door nobody is expecting her at.
      setOnMyWay("idle");
      setNote(
        typeof data.reason === "string"
          ? `Not sent — ${data.reason}. Knock as usual.`
          : "Could not text them. Knock as usual.",
      );
    } catch {
      setOnMyWay("idle");
      setNote("No signal. They have not been told yet.");
    }
  }

  async function start() {
    setWorking(true);
    setNote(null);
    try {
      const response = await fetch("/api/jobs/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      if (!response.ok) throw new Error("start failed");
      setStatus("in_progress");
    } catch {
      setNote("Could not start the job. Check your signal and try again.");
    } finally {
      setWorking(false);
    }
  }

  async function finish() {
    setWorking(true);
    setNote(null);

    // Best-effort location, and genuinely optional: a fix is worst indoors,
    // which is where she is. Nothing waits more than a few seconds for it and
    // nothing fails without it.
    const at = await currentPosition();

    try {
      const response = await fetch("/api/jobs/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, location: at }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      const data = (payload ?? {}) as {
        billable?: unknown;
        outstanding?: { label?: unknown; missing?: unknown }[];
      };

      if (!response.ok) throw new Error("complete failed");

      setStatus("complete");
      setOutstanding(
        Array.isArray(data.outstanding)
          ? data.outstanding.map((gap) => ({
              label: typeof gap.label === "string" ? gap.label : "Room",
              missing: Array.isArray(gap.missing) ? gap.missing.map(String) : [],
            }))
          : [],
      );
    } catch {
      setNote("Could not mark this done. Check your signal and try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      {note && (
        <p className="mt-4 rounded-lg border border-line bg-surface-2 p-3 text-sm text-ink" role="alert">
          {note}
        </p>
      )}

      {status === "assigned" && (
        <button
          type="button"
          onClick={() => void tellThem()}
          disabled={onMyWay !== "idle"}
          className="mt-6 w-full rounded-lg border border-navy px-4 py-3 text-sm font-semibold text-navy disabled:opacity-60"
        >
          {onMyWay === "sent" ? "They know you're coming" : onMyWay === "sending" ? "Texting…" : "On my way"}
        </button>
      )}

      {status === "assigned" && (
        <button
          type="button"
          onClick={() => void start()}
          disabled={working}
          className="mt-3 w-full rounded-lg bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
        >
          {working ? "Starting…" : "I've arrived — start"}
        </button>
      )}

      {status === "in_progress" && (
        <>
          <JobCapture jobId={jobId} rooms={rooms} alreadyDone={alreadyDone} />
          <button
            type="button"
            onClick={() => void finish()}
            disabled={working}
            className="mt-6 w-full rounded-lg bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {working ? "Finishing…" : "Done"}
          </button>
          <p className="mt-2 text-center text-xs text-ink-3">
            You can tap Done even if photos are still uploading.
          </p>
        </>
      )}

      {status === "complete" && (
        <div className="mt-6">
          <Pill tone="good">Done</Pill>
          {outstanding.length > 0 ? (
            <p className="mt-3 text-sm text-ink-2">
              Still to photograph:{" "}
              {outstanding.map((gap) => `${gap.label} (${gap.missing.join(" + ")})`).join(", ")}.
              The job is finished either way — these are needed before it can be invoiced.
            </p>
          ) : (
            <p className="mt-3 text-sm text-ink-2">
              Everything is in. Nothing else needed from you.
            </p>
          )}
          <JobCapture jobId={jobId} rooms={rooms} alreadyDone={alreadyDone} />
        </div>
      )}
    </>
  );
}

/**
 * One reading, or nothing.
 *
 * Times out fast and resolves null on refusal or failure. She is indoors,
 * which is where a fix is worst, and a Done button that hangs waiting for
 * satellites is one she taps four times.
 */
function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { lat: number; lng: number } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    navigator.geolocation.getCurrentPosition(
      (position) => done({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => done(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60_000 },
    );

    setTimeout(() => done(null), 6000);
  });
}
