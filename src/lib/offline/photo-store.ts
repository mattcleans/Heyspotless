"use client";

/**
 * The durable side of the photo queue.
 *
 * IndexedDB rather than localStorage, for two reasons that both matter: it
 * holds Blobs without base64-inflating them by a third, and it is not capped at
 * the five megabytes a 4bd/4ba move-out would blow straight through.
 *
 * THE ORDER OF OPERATIONS IS THE FEATURE. `enqueue` returns only once the bytes
 * are committed to disk. Nothing touches the network until that has happened,
 * so a phone killed the instant after the shutter still has the photo. Every
 * other guarantee in here follows from that one.
 */

import type { QueueItem } from "./queue-policy";
import {
  openPhotoDatabase,
  markWorkPhotoConfirmed,
} from "../../../public/offline-work.js";

const STORE = "queue";

export interface StoredPhoto extends QueueItem {
  blob: Blob;
}

export class QuotaExceeded extends Error {}

const open = openPhotoDatabase;

function run<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = work(tx.objectStore(STORE));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    // Request success is not a committed write. An abort after that success
    // must reject before the caller shows a saved tick or starts an upload.
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(storageError(tx.error ?? request.error));
  });
}

function storageError(error: DOMException | null): Error {
  return error?.name === "QuotaExceededError"
    ? new QuotaExceeded(error.message)
    : (error ?? new Error("Photo storage transaction was aborted"));
}

/**
 * Put a photo on the queue, durably, before anything else happens.
 *
 * Throws rather than resolving if the write fails. A caller that swallowed
 * this would show a cleaner a tick for a photo that does not exist, which is
 * exactly the lie this module is built to prevent.
 */
export async function enqueue(photo: StoredPhoto): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const previous = store.get(photo.id);
      let conflict = false;
      previous.onsuccess = () => {
        if (
          previous.result?.ownerId &&
          previous.result.ownerId !== photo.ownerId
        ) {
          conflict = true;
          tx.abort();
          return;
        }
        store.put(photo);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          conflict
            ? new Error(
                "A photo from another sign-in is still saved. Reconnect or call the office before replacing it.",
              )
            : storageError(tx.error),
        );
    });
  } finally {
    db.close();
  }
}

export async function listForJob(
  jobId: string,
  ownerId?: string | null,
): Promise<StoredPhoto[]> {
  const db = await open();
  try {
    const all = await run<StoredPhoto[]>(
      db,
      "readonly",
      (store) =>
        store.index("byJob").getAll(jobId) as IDBRequest<StoredPhoto[]>,
    );
    return ownerId === undefined
      ? all
      : all.filter((p) => !p.ownerId || p.ownerId === ownerId);
  } finally {
    db.close();
  }
}

/** Everything still outstanding, across every job. Drives the drain loop. */
export async function listOutstanding(): Promise<StoredPhoto[]> {
  const db = await open();
  try {
    return await new Promise<StoredPhoto[]>((resolve, reject) => {
      const tx = db.transaction([STORE, "device"], "readonly");
      const owner = tx.objectStore("device").get("owner");
      const photos = tx.objectStore(STORE).getAll() as IDBRequest<
        StoredPhoto[]
      >;
      tx.oncomplete = () =>
        resolve(
          photos.result.filter(
            (p) =>
              p.state !== "done" &&
              (!p.ownerId || p.ownerId === owner.result?.ownerId),
          ),
        );
      tx.onabort = () => reject(storageError(tx.error));
    });
  } finally {
    db.close();
  }
}

export async function update(item: QueueItem): Promise<boolean> {
  return changeIfCurrent(item, false);
}

/** A retake has a new revision even if both shutters share a millisecond. */
export function samePhoto(a: QueueItem, b: QueueItem): boolean {
  return (
    a.id === b.id &&
    a.jobId === b.jobId &&
    (a.revision ?? a.takenAt) === (b.revision ?? b.takenAt)
  );
}

async function changeIfCurrent(
  item: QueueItem,
  remove: boolean,
): Promise<boolean> {
  const db = await open();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      // Read and conditional mutation share one transaction. A new capture
      // cannot be overwritten or deleted by an older upload's settlement.
      const tx = db.transaction([STORE, "work"], "readwrite");
      const objectStore = tx.objectStore(STORE);
      const request = objectStore.get(item.id) as IDBRequest<
        StoredPhoto | undefined
      >;
      let changed = false;
      request.onsuccess = () => {
        const existing = request.result;
        if (!existing || !samePhoto(existing, item)) return;
        if (remove) {
          objectStore.delete(item.id);
          markWorkPhotoConfirmed(tx, item);
        } else objectStore.put({ ...existing, ...item });
        changed = true;
      };
      tx.oncomplete = () => resolve(changed);
      tx.onabort = () => reject(storageError(tx.error ?? request.error));
    });
  } finally {
    db.close();
  }
}

/**
 * Remove a photo — ONLY ever called once the server has confirmed it.
 *
 * Not on error, not on timeout, not on a 500, and not when the queue looks
 * long. The single caller is the success path of the drain loop.
 */
export async function forget(photo: QueueItem): Promise<boolean> {
  return changeIfCurrent(photo, true);
}

/** Is durable storage available at all? A private window may say no. */
export async function isAvailable(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  try {
    (await open()).close();
    return true;
  } catch {
    return false;
  }
}
