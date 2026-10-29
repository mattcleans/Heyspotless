"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrivalTextControls } from "./arrival-text-controls";
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
  roomScopeAvailable?: boolean;
  alreadyDone: { roomKey: string; kind: string; revision?: string }[];
  backupBlocked?: boolean;
  ownerId?: string | null;
  checkedAt?: number;
  scheduledAt?: string | null;
}

export function JobFlow({
  jobId,
  initialStatus,
  rooms,
  roomScopeAvailable = true,
  alreadyDone,
  backupBlocked = false,
  ownerId = null,
  checkedAt = 0,
  scheduledAt = null,
}: JobFlowProps) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(initialStatus);
  const [blocked, setBlocked] = useState(backupBlocked);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [outstanding, setOutstanding] = useState<
    { label: string; missing: string[] }[] | null
  >(null);
  const [serverScopeAvailable, setServerScopeAvailable] = useState(true);
  const scopeAvailable = roomScopeAvailable && serverScopeAvailable;
  const [verifiedAt, setVerifiedAt] = useState(checkedAt);
  const work = useMemo<SavedWork | null>(
    () =>
      scopeAvailable && ownerId && status !== "assigned"
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
    [scopeAvailable, ownerId, status, jobId, rooms, alreadyDone, verifiedAt, scheduledAt],
  );

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
        requirementsAvailable?: unknown;
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
      if (data.requirementsAvailable === false) setServerScopeAvailable(false);
      setVerifiedAt(Date.now());
      router.refresh();
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
        requirementsAvailable?: unknown;
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
      if (data.requirementsAvailable === false) setServerScopeAvailable(false);
      setVerifiedAt(Date.now());
      setOutstanding(
        data.requirementsAvailable === true && Array.isArray(data.outstanding)
          ? data.outstanding.map((gap) => ({
              label: typeof gap.label === "string" ? gap.label : "Room",
              missing: Array.isArray(gap.missing)
                ? gap.missing.map(String)
                : [],
            }))
          : null,
      );
      router.refresh();
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

      {status === "assigned" && !blocked && !needsSignIn && <ArrivalTextControls key={jobId} jobId={jobId} />}

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
          {scopeAvailable ? <JobCapture
            jobId={jobId}
            rooms={rooms}
            alreadyDone={alreadyDone}
            ownerId={ownerId}
          /> : <p className="visit-feature mt-4">The saved room list needs office review. Your saved photos stay on this device. You can still finish the visit.</p>}
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
          {scopeAvailable ? <JobCapture
            jobId={jobId}
            rooms={rooms}
            alreadyDone={alreadyDone}
            ownerId={ownerId}
          /> : <p className="visit-feature mt-4">The visit is finished. Ask the office to check the saved room list before adding photos; your saved copies remain on this device.</p>}
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
