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

const DB_NAME = "spotless-photos";
const DB_VERSION = 1;
const STORE = "queue";

export interface StoredPhoto extends QueueItem {
  blob: Blob;
}

export class QuotaExceeded extends Error {}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("byJob", "jobId");
        store.createIndex("byState", "state");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb unavailable"));
  });
}

function run<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = work(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const error = request.error;
      // A full disk is not a transient failure and must not be retried
      // silently — she needs to be told before she takes twenty more.
      reject(error?.name === "QuotaExceededError" ? new QuotaExceeded(error.message) : error);
    };
  });
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
    await run(db, "readwrite", (store) => store.put(photo));
  } finally {
    db.close();
  }
}

export async function listForJob(jobId: string): Promise<StoredPhoto[]> {
  const db = await open();
  try {
    const all = await run<StoredPhoto[]>(db, "readonly", (store) =>
      store.index("byJob").getAll(jobId) as IDBRequest<StoredPhoto[]>,
    );
    return all;
  } finally {
    db.close();
  }
}

/** Everything still outstanding, across every job. Drives the drain loop. */
export async function listOutstanding(): Promise<StoredPhoto[]> {
  const db = await open();
  try {
    const all = await run<StoredPhoto[]>(db, "readonly", (store) =>
      store.getAll() as IDBRequest<StoredPhoto[]>,
    );
    return all.filter((p) => p.state !== "done");
  } finally {
    db.close();
  }
}

export async function update(item: QueueItem): Promise<void> {
  const db = await open();
  try {
    const existing = await run<StoredPhoto | undefined>(db, "readonly", (store) =>
      store.get(item.id) as IDBRequest<StoredPhoto | undefined>,
    );
    if (!existing) return;
    await run(db, "readwrite", (store) => store.put({ ...existing, ...item }));
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
export async function forget(id: string): Promise<void> {
  const db = await open();
  try {
    await run(db, "readwrite", (store) => store.delete(id));
  } finally {
    db.close();
  }
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
