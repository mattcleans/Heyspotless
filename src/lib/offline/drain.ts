"use client";

/**
 * The loop that gets queued photos to the server.
 *
 * Every decision it makes comes from queue-policy.ts, which is pure and tested;
 * this is the part that touches the network and IndexedDB. The division is
 * deliberate — "when do we retry" is the interesting logic and it should be
 * assertable without a browser.
 *
 * THE ONE INVARIANT: a photo is removed from the queue if and only if the
 * server has confirmed it. Every failure path below leaves the row where it is.
 */

import { createClient } from "../supabase/client";
import { PHOTO_BUCKET } from "./bucket";
import * as store from "./photo-store";
import {
  afterFailure,
  beginUpload,
  nextToUpload,
  recoverStalled,
  storagePathFor,
  summarise,
  type QueueSummary,
} from "./queue-policy";

/** When each in-flight upload began, so a stalled one can be recovered. */
const startedAt = new Map<string, number>();

let running = false;

export type DrainListener = (summary: QueueSummary) => void;

/**
 * Drain until the queue is empty or nothing is ready.
 *
 * Re-entrant-safe: a second call while one is running returns immediately
 * rather than uploading the same photo twice. The loop is restarted by the
 * caller on `online`, on an interval, and when a photo is added.
 */
export async function drain(notify?: DrainListener): Promise<void> {
  if (running) return;
  running = true;

  try {
    for (;;) {
      const now = Date.now();
      const outstanding = await store.listOutstanding();
      notify?.(summarise(outstanding));

      if (outstanding.length === 0) return;

      // Anything that claimed to be uploading and never came back — a tab
      // closed, a tunnel, a process killed. Put it back in the queue.
      const recovered = recoverStalled(outstanding, now, startedAt);
      for (const item of recovered) {
        const before = outstanding.find((o) => o.id === item.id);
        if (before && before.state !== item.state) {
          startedAt.delete(item.id);
          await store.update(item);
        }
      }

      const online = typeof navigator === "undefined" ? true : navigator.onLine;
      const next = nextToUpload(recovered, now, online);
      if (!next) return;

      await store.update(beginUpload(next));
      startedAt.set(next.id, now);

      const photo = (await store.listForJob(next.jobId)).find((p) => p.id === next.id);
      if (!photo) {
        // Gone from under us — already confirmed by another tab.
        startedAt.delete(next.id);
        continue;
      }

      try {
        await upload(photo);
        // THE ONLY DELETE. The server has it.
        await store.forget(next.id);
        startedAt.delete(next.id);
      } catch (error) {
        startedAt.delete(next.id);
        await store.update(afterFailure(next, Date.now(), messageOf(error)));
        // Stop this pass rather than hammering a connection that is clearly
        // not working. The next tick picks it up after the backoff.
        notify?.(summarise(await store.listOutstanding()));
        return;
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Put the bytes in storage, then tell the server about them.
 *
 * In that order, and both idempotent. The storage path is derived from (job,
 * room, kind) so a retry overwrites rather than orphaning, and
 * `record_job_photo` is unique on the same triple — so an upload that
 * succeeded but whose response was lost costs one wasted PUT and nothing else.
 */
async function upload(photo: store.StoredPhoto): Promise<void> {
  const path = storagePathFor(photo.jobId, photo.roomKey, photo.kind);
  const supabase = createClient();

  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, photo.blob, {
    contentType: photo.blob.type || "image/jpeg",
    upsert: true,
  });
  if (error) throw new Error(`storage: ${error.message}`);

  const response = await fetch("/api/jobs/photo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jobId: photo.jobId,
      roomKey: photo.roomKey,
      kind: photo.kind,
      storagePath: path,
    }),
  });

  if (!response.ok) {
    throw new Error(`record: ${response.status}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "upload failed";
}
