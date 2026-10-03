"use client";

import { useEffect, useState } from "react";
import {
  persistOwnedWork,
  forgetOwnedWork,
  prepareWorkShell,
} from "@/lib/offline/device";
import type { SavedWork } from "../../public/offline-work.js";

export function OfflineWorkRecovery({
  work,
  ownerId,
  jobId,
  checkedAt,
}: {
  work: SavedWork | null;
  ownerId: string | null;
  jobId: string;
  checkedAt: number;
}) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const save = () => {
      if (!ownerId) return;
      void (async () => {
        if (!work) {
          await forgetOwnedWork(jobId, ownerId, checkedAt);
          return;
        }
        const saved = await persistOwnedWork(work);
        if (!saved) {
          if (alive) {
            setReady(false);
            setFailed(true);
          }
          return;
        }
        await prepareWorkShell();
        if (alive) {
          setReady(true);
          setFailed(false);
        }
      })().catch(() => {
        if (alive) {
          setReady(false);
          setFailed(true);
        }
      });
    };
    const unavailable = () => {
      if (alive) setFailed(true);
    };
    window.addEventListener("spotless-work-ready", save);
    window.addEventListener("spotless-work-unavailable", unavailable);
    save();
    return () => {
      alive = false;
      window.removeEventListener("spotless-work-ready", save);
      window.removeEventListener("spotless-work-unavailable", unavailable);
    };
  }, [work, ownerId, jobId, checkedAt]);
  if (!ownerId || !work) return null;
  return (
    <p
      className="mt-4 rounded-lg border border-line bg-surface-2 p-3 text-sm text-ink-2"
      role="status"
    >
      {ready
        ? "This checklist is saved for offline reopening on this phone. Photos stay here until uploaded. Reconnect to check the current visit and confirm Done."
        : failed
          ? "Offline reopening could not be prepared. Keep this visit open while you have no signal. Your saved photos remain on this phone."
          : "Preparing this checklist for offline reopening…"}
    </p>
  );
}
