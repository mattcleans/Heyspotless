"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { compress } from "@/lib/offline/compress";
import * as store from "@/lib/offline/photo-store";
import { drain } from "@/lib/offline/drain";
import { summarise, type QueueSummary } from "@/lib/offline/queue-policy";
import type { Room } from "@/lib/service/rooms";

/**
 * Photographing a job, room by room.
 *
 * THE ONE RULE THIS SCREEN EXISTS TO HONOUR: a photo is on disk before
 * anything else happens. The tick she sees means "saved", not "uploaded", and
 * the difference is stated on the screen rather than glossed — because the
 * failure mode being designed out is a cleaner who believes her work went
 * through and finds out on Friday that it did not.
 *
 * Uploading is the queue's problem and it happens in the background, retrying
 * for as long as it takes. She can close the app, drive home and open it on
 * her own wifi, and the photos are still there. Reopening the visit resumes
 * uploads; the browser need not keep running after it is closed.
 */

type Kind = "before" | "after";

export interface JobCaptureProps {
  jobId: string;
  rooms: Room[];
  /** Rooms already photographed on the server, so a reinstall does not start over. */
  alreadyDone: { roomKey: string; kind: string }[];
  ownerId?: string | null;
}

export function JobCapture({
  jobId,
  rooms,
  alreadyDone,
  ownerId = null,
}: JobCaptureProps) {
  const [taken, setTaken] = useState<Set<string>>(
    () => new Set(alreadyDone.map((p) => `${p.roomKey}:${p.kind}`)),
  );
  const [queue, setQueue] = useState<QueueSummary>({
    outstanding: 0,
    struggling: 0,
    busy: false,
  });
  const [durable, setDurable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef<{ roomKey: string; kind: Kind } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // What is already queued locally counts as taken — she should not be asked
  // to reshoot a room whose photo is sitting on this device waiting for signal.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (!(await store.isAvailable()))
          throw new Error("storage unavailable");
        const queued = await store.listForJob(jobId, ownerId);
        if (cancelled) return;
        setTaken((current) => {
          const next = new Set(current);
          for (const photo of queued)
            next.add(`${photo.roomKey}:${photo.kind}`);
          return next;
        });
        setQueue(summarise(queued));
      } catch {
        if (!cancelled) setDurable(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId, ownerId]);

  // Drain now, whenever the connection comes back, and on a slow tick for the
  // case where `online` lies — which on a phone moving between cells it often
  // does.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      void drain((summary) => {
        if (!cancelled) {
          setQueue(summary);
          setUploadError(false);
        }
      }, jobId).catch(() => {
        if (!cancelled) setUploadError(true);
      });
    };
    tick();

    const interval = setInterval(tick, 20_000);
    window.addEventListener("online", tick);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("online", tick);
    };
  }, [jobId]);

  async function retryUploads() {
    setRetrying(true);
    try {
      await drain(setQueue, jobId, true);
      setUploadError(false);
    } catch {
      setUploadError(true);
    } finally {
      setRetrying(false);
    }
  }

  const capture = useCallback((roomKey: string, kind: Kind) => {
    pending.current = { roomKey, kind };
    setError(null);
    input.current?.click();
  }, []);

  const onFile = useCallback(
    async (file: File | undefined) => {
      const target = pending.current;
      pending.current = null;
      if (!file || !target) return;

      setSaving(true);
      try {
        const blob = await compress(file);

        // DURABLE FIRST. Nothing touches the network until this resolves.
        await store.enqueue({
          id: `${jobId}:${target.roomKey}:${target.kind}`,
          jobId,
          ownerId: ownerId ?? undefined,
          roomKey: target.roomKey,
          kind: target.kind,
          takenAt: Date.now(),
          revision: crypto.randomUUID(),
          state: "pending",
          attempts: 0,
          nextAttemptAt: Date.now(),
          blob,
        });

        setTaken((current) =>
          new Set(current).add(`${target.roomKey}:${target.kind}`),
        );
        setDurable(true);
        void store
          .listForJob(jobId, ownerId)
          .then((photos) => setQueue(summarise(photos)))
          .catch(() => setUploadError(true));
        void drain(setQueue, jobId).catch(() => setUploadError(true));
      } catch (caught) {
        // Never a silent failure. If it is not saved she has to know NOW,
        // while she is still standing in the room.
        setError(
          caught instanceof store.QuotaExceeded
            ? "No space left on this phone to save the photo. Free some up and take it again."
            : "That photo did not save. Take it again.",
        );
      } finally {
        setSaving(false);
      }
    },
    [jobId, ownerId],
  );

  const outstanding = rooms.reduce(
    (count, room) =>
      count +
      (taken.has(`${room.key}:before`) ? 0 : 1) +
      (taken.has(`${room.key}:after`) ? 0 : 1),
    0,
  );

  return (
    <section className="mt-6">
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          void onFile(event.target.files?.[0]);
          // Cleared so retaking the same room fires `change` again.
          event.target.value = "";
        }}
      />

      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold text-ink">Photos</h2>
        <span className="nums text-xs text-ink-3">
          {outstanding === 0 ? "All rooms done" : `${outstanding} left`}
        </span>
      </div>

      {!durable && (
        <p className="mt-2 rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink-2">
          Photo storage could not be opened. A photo is marked saved only after
          it is stored on this device. Try Safari or Chrome outside a private
          window. Call the office if you cannot save your photos.
        </p>
      )}

      {error && (
        <p
          className="mt-2 rounded-lg border border-line bg-surface-2 p-3 text-sm text-ink"
          role="alert"
        >
          {error}
        </p>
      )}

      {saving && (
        <p className="mt-2 text-xs text-ink-2" role="status">
          Saving photo on this device…
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {rooms.map((room) => (
          <li
            key={room.key}
            className="card flex items-center justify-between gap-3 p-3"
          >
            <span className="text-sm text-ink">{room.label}</span>
            <span className="flex gap-2">
              {(["before", "after"] as const).map((kind) => {
                const done = taken.has(`${room.key}:${kind}`);
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => capture(room.key, kind)}
                    disabled={saving}
                    aria-label={`${done ? "Retake" : "Take"} ${kind} photo for ${room.label}`}
                    className={`min-h-11 min-w-11 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-60 ${
                      done
                        ? "border border-line bg-surface-2 text-ink-3"
                        : "bg-navy text-white"
                    }`}
                  >
                    {done ? `${kind} ✓` : kind}
                  </button>
                );
              })}
            </span>
          </li>
        ))}
      </ul>

      {/*
        Said plainly rather than hidden behind a spinner. A tick means the
        photo is saved on this phone; reopening this visit resumes the queue.
      */}
      {queue.outstanding > 0 && (
        <div className="card mt-3 p-3" role="status">
          <p className="text-xs text-ink-2">
            {queue.outstanding} photo{queue.outstanding === 1 ? "" : "s"} saved
            on this phone, waiting to upload for this visit. Keep this visit
            open while they upload. If you close the app, reopen this visit to
            resume.
            {queue.struggling > 0 && (
              <>
                {" "}
                <strong className="text-ink-2">
                  {queue.struggling} {queue.struggling === 1 ? "is" : "are"}{" "}
                  having trouble
                </strong>
                . The photos remain saved on this device.
              </>
            )}
          </p>
          {queue.authRequired && (
            <p className="mt-2 text-xs text-ink-2">
              Sign in again to finish uploading. Your saved photos remain on
              this device.{" "}
              <Link
                className="underline"
                href={`/login?next=${encodeURIComponent(`/cleaner/job/${jobId}`)}`}
              >
                Sign in
              </Link>
            </p>
          )}
          <button
            type="button"
            onClick={() => void retryUploads()}
            disabled={retrying}
            className="mt-2 min-h-11 rounded-lg border border-line px-3 text-xs font-semibold text-navy disabled:opacity-60"
          >
            {retrying ? "Checking uploads…" : "Retry uploads"}
          </button>
        </div>
      )}
      {uploadError && (
        <p className="mt-3 text-sm text-ink-2" role="alert">
          Upload status could not be checked. Keep this visit open and try
          again.{" "}
          <button
            type="button"
            className="min-h-11 px-2 font-semibold underline"
            onClick={() => void retryUploads()}
            disabled={retrying}
          >
            Retry
          </button>
        </p>
      )}
    </section>
  );
}
