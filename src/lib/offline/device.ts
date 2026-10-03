"use client";

import {
  setWorkOwner,
  saveWork,
  removeWork,
  type SavedWork,
} from "../../../public/offline-work.js";

let prepared: Promise<void> | null = null;
export function prepareWorkDevice(ownerId: string | null): Promise<void> {
  prepared = setWorkOwner(ownerId);
  return prepared;
}
export async function persistOwnedWork(work: SavedWork): Promise<boolean> {
  if (prepared) await prepared;
  return saveWork(work);
}
export async function forgetOwnedWork(
  jobId: string,
  ownerId: string,
  checkedAt: number,
): Promise<boolean> {
  if (prepared) await prepared;
  return removeWork(jobId, ownerId, checkedAt);
}

/** Confirm the active worker actually implements recovery, not just push. */
export async function prepareWorkShell(): Promise<void> {
  if (!navigator.serviceWorker)
    throw new Error("Offline reopening unavailable");
  let initialTimeout: ReturnType<typeof setTimeout> | undefined;
  const registration = await Promise.race([
    (async () => {
      await navigator.serviceWorker.register("/sw.js");
      return navigator.serviceWorker.ready;
    })(),
    new Promise<never>((_, reject) => {
      initialTimeout = setTimeout(
        () => reject(new Error("Offline reopening unavailable")),
        5000,
      );
    }),
  ]).finally(() => {
    clearTimeout(initialTimeout);
  });
  await new Promise<void>((resolve, reject) => {
    let closed = false;
    const channels: MessageChannel[] = [];
    const finish = (error?: Error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", ask);
      for (const channel of channels) {
        channel.port1.close();
        channel.port2.close();
      }
      if (error) reject(error);
      else resolve();
    };
    const ask = () => {
      const channel = new MessageChannel();
      channels.push(channel);
      channel.port1.onmessage = (event) => {
        if (event.data === "offline-work-ready") finish();
      };
      (navigator.serviceWorker.controller ?? registration.active)?.postMessage(
        "offline-work-ready",
        [channel.port2],
      );
    };
    const timeout = setTimeout(
      () => finish(new Error("Offline reopening unavailable")),
      5000,
    );
    navigator.serviceWorker.addEventListener("controllerchange", ask);
    ask();
  });
}
