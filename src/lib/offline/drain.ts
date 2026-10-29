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
import { fetchWithTimeout } from "../http/fetch-with-timeout";
import { readPhotoCaptureReceipt, type PhotoCapture } from "../service/photo-capture";
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

let running: Promise<void> | null = null;
const listeners = new Set<(items: store.StoredPhoto[]) => void>();

export type DrainListener = (summary: QueueSummary) => void;

/**
 * Drain until the queue is empty or nothing is ready.
 *
 * Re-entrant-safe: callers share one pass and receive their own visit summary
 * rather than uploading the same photo twice. The loop is restarted by the
 * caller on `online`, on an interval, and when a photo is added.
 */
export async function drain(
  notify?: DrainListener,
  jobId?: string,
  retryNow = false,
): Promise<void> {
  const listener = (items: store.StoredPhoto[]) =>
    notify?.(summarise(items, jobId));
  listeners.add(listener);
  try {
    if (retryNow) {
      for (const photo of await store.listOutstanding()) {
        if (
          photo.state === "pending" &&
          (jobId === undefined || photo.jobId === jobId)
        ) {
          await store.update({ ...photo, nextAttemptAt: Date.now() });
        }
      }
    }
    if (!running) {
      const run = async () => {
        // Serialize upload passes between tabs where Web Locks is available.
        // Conditional revision checks still protect local retakes everywhere.
        if (typeof navigator !== "undefined" && navigator.locks) {
          await navigator.locks.request("spotless-photo-upload", drainLoop);
        } else {
          await drainLoop();
        }
      };
      running = run().finally(() => {
        running = null;
      });
    }
    await running;
  } finally {
    listeners.delete(listener);
  }
}

function notifyListeners(items: store.StoredPhoto[]) {
  for (const listener of listeners) listener(items);
}

async function drainLoop(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const outstanding = await store.listOutstanding();
    notifyListeners(outstanding);

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

    if (!next.revision) {
      const legacy = (await store.listForJob(next.jobId)).find(p => p.id === next.id);
      if (legacy) await store.ensureCaptureRevision(legacy);
      continue;
    }
    if (!(await store.update(beginUpload(next)))) continue;
    startedAt.set(next.id, now);

    const photo = (await store.listForJob(next.jobId)).find(
      (p) => p.id === next.id,
    );
    if (!photo || !store.samePhoto(photo, next)) {
      // Gone from under us — already confirmed by another tab.
      startedAt.delete(next.id);
      continue;
    }

    try {
      await upload(photo);
      // THE ONLY DELETE. The server has it.
      await store.forget(photo);
      startedAt.delete(next.id);
    } catch (error) {
      startedAt.delete(next.id);
      await store.update(afterFailure(next, Date.now(), messageOf(error)));
      // Stop this pass rather than hammering a connection that is clearly
      // not working. The next tick picks it up after the backoff.
      notifyListeners(await store.listOutstanding());
      return;
    }
  }
}

/**
 * Put the bytes in storage, then tell the server about them.
 *
 * Each capture gets its own immutable path. A retry never overwrites it.
 * An already-existing object still needs server byte/version verification;
 * a storage conflict by itself cannot acknowledge or discard local bytes.
 */
async function upload(photo: store.StoredPhoto): Promise<void> {
  if (!photo.revision) throw new Error("record: capture identity missing");
  const path = storagePathFor(photo.jobId, photo.roomKey, photo.kind, photo.revision);
  const digest = await crypto.subtle.digest("SHA-256", await photo.blob.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  const capture: PhotoCapture = { jobId: photo.jobId, roomKey: photo.roomKey, kind: photo.kind,
    storagePath: path, revision: photo.revision, sha256, supersedes: photo.supersedes ?? [] };
  const supabase = createClient();
  if (photo.ownerId) {
    const { data, error } = await supabase.auth.getUser();
    // A tunnel, timeout or unavailable auth server does not invalidate her
    // login. Keep the bytes queued without sending her through sign-in.
    if (error && (!error.status || error.status >= 500 || error.status === 429))
      throw new Error("session: unavailable");
    if (error || data.user?.id !== photo.ownerId)
      throw new Error("record: 401");
  }

  const { error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(path, photo.blob, {
      contentType: photo.blob.type || "image/jpeg",
      upsert: false,
    });
  const exists = error && "statusCode" in error && (Number(error.statusCode) === 409 || (Number(error.statusCode) === 400 && "error" in error && error.error === "Duplicate"));
  if (error && !exists) {
    if ("statusCode" in error && Number(error.statusCode) === 401)
      throw new Error("storage: 401");
    throw new Error(`storage: ${error.message}`);
  }

  const response = await fetchWithTimeout("/api/jobs/photo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(capture),
  });

  if (!response.ok) {
    throw new Error(`record: ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!readPhotoCaptureReceipt(payload, capture)) {
    throw new Error("record: unconfirmed");
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "upload failed";
}
