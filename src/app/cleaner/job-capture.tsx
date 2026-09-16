"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * her own wifi, and the photos are still there.
 */

type Kind = "before" | "after";

export interface JobCaptureProps {
  jobId: string;
  rooms: Room[];
  /** Rooms already photographed on the server, so a reinstall does not start over. */
  alreadyDone: { roomKey: string; kind: string }[];
}

export function JobCapture({ jobId, rooms, alreadyDone }: JobCaptureProps) {
  const [taken, setTaken] = useState<Set<string>>(
    () => new Set(alreadyDone.map((p) => `${p.roomKey}:${p.kind}`)),
  );
  const [queue, setQueue] = useState<QueueSummary>({ outstanding: 0, struggling: 0, busy: false });
  const [durable, setDurable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ roomKey: string; kind: Kind } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // What is already queued locally counts as taken — she should not be asked
  // to reshoot a room whose photo is sitting on this device waiting for signal.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!(await store.isAvailable())) {
        if (!cancelled) setDurable(false);
        return;
      }
      const queued = await store.listForJob(jobId);
      if (cancelled) return;

      setTaken((current) => {
        const next = new Set(current);
        for (const photo of queued) next.add(`${photo.roomKey}:${photo.kind}`);
        return next;
      });
      setQueue(summarise(queued));
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Drain now, whenever the connection comes back, and on a slow tick for the
  // case where `online` lies — which on a phone moving between cells it often
  // does.
  useEffect(() => {
    const tick = () => void drain(setQueue);
    tick();

    const interval = setInterval(tick, 20_000);
    window.addEventListener("online", tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", tick);
    };
  }, []);

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

      try {
        const blob = await compress(file);

        // DURABLE FIRST. Nothing touches the network until this resolves.
        await store.enqueue({
          id: `${jobId}:${target.roomKey}:${target.kind}`,
          jobId,
          roomKey: target.roomKey,
          kind: target.kind,
          takenAt: Date.now(),
          state: "pending",
          attempts: 0,
          nextAttemptAt: Date.now(),
          blob,
        });

        setTaken((current) => new Set(current).add(`${target.roomKey}:${target.kind}`));
        void drain(setQueue);
      } catch (caught) {
        // Never a silent failure. If it is not saved she has to know NOW,
        // while she is still standing in the room.
        setError(
          caught instanceof store.QuotaExceeded
            ? "No space left on this phone to save the photo. Free some up and take it again."
            : "That photo did not save. Take it again.",
        );
      }
    },
    [jobId],
  );

  const outstanding = rooms.reduce(
    (count, room) =>
      count + (taken.has(`${room.key}:before`) ? 0 : 1) + (taken.has(`${room.key}:after`) ? 0 : 1),
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
          This browser will not let the app save photos offline, so they have to upload as you
          take them. On a weak signal, use Safari or Chrome rather than a private window.
        </p>
      )}

      {error && (
        <p className="mt-2 rounded-lg border border-line bg-surface-2 p-3 text-sm text-ink" role="alert">
          {error}
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {rooms.map((room) => (
          <li key={room.key} className="card flex items-center justify-between gap-3 p-3">
            <span className="text-sm text-ink">{room.label}</span>
            <span className="flex gap-2">
              {(["before", "after"] as const).map((kind) => {
                const done = taken.has(`${room.key}:${kind}`);
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => capture(room.key, kind)}
                    className={`rounded-lg px-3 py-2 text-xs font-semibold ${
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
        photo is safe on this phone; the queue is what gets it to us, and she
        can close the app while it does.
      */}
      {queue.outstanding > 0 && (
        <p className="mt-3 text-xs text-ink-3">
          {queue.outstanding} photo{queue.outstanding === 1 ? "" : "s"} saved on this phone,
          uploading in the background. You can close the app — they will keep trying.
          {queue.struggling > 0 && (
            <>
              {" "}
              <strong className="text-ink-2">
                {queue.struggling} {queue.struggling === 1 ? "is" : "are"} having trouble
              </strong>{" "}
              — they are not lost, but they need a better signal.
            </>
          )}
        </p>
      )}
    </section>
  );
}
