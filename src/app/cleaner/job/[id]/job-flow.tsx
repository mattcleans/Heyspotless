"use client";

import Link from "next/link";
import { VisitRefresh } from "@/components/visit-refresh";
import { useMemo, useState } from "react";
import { OfflineWorkRecovery } from "@/components/offline-work-recovery";
import type { SavedWork } from "../../../../../public/offline-work.js";
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
 * when this visit is open. Reopening the visit resumes queued uploads.
 */

type Status = "assigned" | "in_progress" | "complete";

export interface JobFlowProps {
  jobId: string;
  initialStatus: Status;
  rooms: Room[];
  alreadyDone: { roomKey: string; kind: string }[];
  backupBlocked?: boolean;
  ownerId?: string | null;
  checkedAt?: number;
  scheduledAt?: string | null;
}

export function JobFlow({
  jobId,
  initialStatus,
  rooms,
  alreadyDone,
  backupBlocked = false,
  ownerId = null,
  checkedAt = 0,
  scheduledAt = null,
}: JobFlowProps) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [blocked, setBlocked] = useState(backupBlocked);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [outstanding, setOutstanding] = useState<
    { label: string; missing: string[] }[] | null
  >(null);
  const [onMyWay, setOnMyWay] = useState<"idle" | "sending" | "sent">("idle");
  const [verifiedAt, setVerifiedAt] = useState(checkedAt);
  const work = useMemo<SavedWork | null>(
    () =>
      ownerId && status !== "assigned"
        ? {
            jobId,
            ownerId,
            status,
            rooms,
            confirmed: alreadyDone,
            checkedAt: verifiedAt,
            scheduledAt,
          }
        : null,
    [ownerId, status, jobId, rooms, alreadyDone, verifiedAt, scheduledAt],
  );

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
      const data = (await response.json().catch(() => ({}))) as {
        started?: unknown;
        error?: unknown;
        code?: unknown;
      };
      if (response.status === 401) setNeedsSignIn(true);
      if (data.code === "backup_approval_required") setBlocked(true);
      if (!response.ok || data.started !== true) {
        setNote(
          typeof data.error === "string"
            ? data.error
            : "Could not confirm the visit started. Refresh or try again.",
        );
        return;
      }
      setStatus("in_progress");
      setVerifiedAt(Date.now());
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
        completed?: unknown;
        error?: unknown;
        code?: unknown;
        billable?: unknown;
        outstanding?: { label?: unknown; missing?: unknown }[];
      };

      if (response.status === 401) setNeedsSignIn(true);
      if (!response.ok || data.completed !== true) {
        setNote(
          typeof data.error === "string"
            ? data.error
            : "Could not confirm this visit finished. Refresh or try again.",
        );
        return;
      }

      setStatus("complete");
      setVerifiedAt(Date.now());
      setOutstanding(
        Array.isArray(data.outstanding)
          ? data.outstanding.map((gap) => ({
              label: typeof gap.label === "string" ? gap.label : "Room",
              missing: Array.isArray(gap.missing)
                ? gap.missing.map(String)
                : [],
            }))
          : null,
      );
    } catch {
      setNote("Could not mark this done. Check your signal and try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <>
      <OfflineWorkRecovery
        work={work}
        ownerId={ownerId}
        jobId={jobId}
        checkedAt={verifiedAt}
      />
      {note && (
        <p
          className="mt-4 rounded-lg border border-line bg-surface-2 p-3 text-sm text-ink"
          role="alert"
        >
          {note}
        </p>
      )}

      {status === "assigned" && !blocked && !needsSignIn && (
        <button
          type="button"
          onClick={() => void tellThem()}
          disabled={onMyWay !== "idle"}
          className="mt-6 w-full rounded-lg border border-navy px-4 py-3 text-sm font-semibold text-navy disabled:opacity-60"
        >
          {onMyWay === "sent"
            ? "They know you're coming"
            : onMyWay === "sending"
              ? "Texting…"
              : "On my way"}
        </button>
      )}

      {status === "assigned" && !blocked && !needsSignIn && (
        <button
          type="button"
          onClick={() => void start()}
          disabled={working}
          className="mt-3 w-full rounded-lg bg-navy px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
        >
          {working ? "Starting…" : "I've arrived — start"}
        </button>
      )}

      {needsSignIn && (
        <Link
          className="secondary-action mt-4 inline-flex"
          href={`/login?next=${encodeURIComponent(`/cleaner/job/${jobId}`)}`}
        >
          Sign in to continue
        </Link>
      )}
      {status === "assigned" && blocked && (
        <section className="visit-feature mt-5" role="status">
          <h2 className="font-semibold text-navy">
            Waiting for client approval
          </h2>
          <p className="mt-2 text-sm">
            This visit has a backup cleaner. Do not start work until the client
            approves the current backup. Refresh for their decision or call the
            office.
          </p>
          <VisitRefresh label="Check approval" />
        </section>
      )}
      {status === "in_progress" && (
        <>
          <JobCapture
            jobId={jobId}
            rooms={rooms}
            alreadyDone={alreadyDone}
            ownerId={ownerId}
          />
          <button
            type="button"
            onClick={() => void finish()}
            disabled={working || needsSignIn}
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
          {outstanding && outstanding.length > 0 ? (
            <p className="mt-3 text-sm text-ink-2">
              Photo requirements recorded when you finished:{" "}
              {outstanding
                .map((gap) => `${gap.label} (${gap.missing.join(" + ")})`)
                .join(", ")}
              . The visit is finished. Check the checklist below for what is
              saved and still uploading.
            </p>
          ) : (
            <p className="mt-3 text-sm text-ink-2">
              {outstanding
                ? "The server confirmed all required photos when you finished."
                : "This visit is finished. Check the photo checklist below for saved photos and any remaining uploads."}
            </p>
          )}
          <JobCapture
            jobId={jobId}
            rooms={rooms}
            alreadyDone={alreadyDone}
            ownerId={ownerId}
          />
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
      (position) =>
        done({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => done(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60_000 },
    );

    setTimeout(() => done(null), 6000);
  });
}
