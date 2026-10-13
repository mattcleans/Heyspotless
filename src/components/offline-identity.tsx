"use client";

import { useEffect } from "react";
import { prepareWorkDevice } from "@/lib/offline/device";

/** Clear local checklist visibility on profile changes; keep pending bytes. */
export function OfflineIdentity({ ownerId }: { ownerId: string | null }) {
  useEffect(() => {
    let alive = true;
    void prepareWorkDevice(ownerId)
      .then(() => {
        if (alive) window.dispatchEvent(new Event("spotless-work-ready"));
        if (typeof BroadcastChannel !== "undefined") {
          const channel = new BroadcastChannel("spotless-work");
          channel.postMessage("identity");
          channel.close();
        }
      })
      .catch(() => {
        if (alive) window.dispatchEvent(new Event("spotless-work-unavailable"));
      });
    return () => {
      alive = false;
    };
  }, [ownerId]);
  return null;
}
