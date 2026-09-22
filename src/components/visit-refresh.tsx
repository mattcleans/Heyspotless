"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

/** Pause background refresh when the customer is not looking at the visit. */
export function VisitRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <p className="text-xs text-ink-2">Checks for updates every 30 seconds while open.</p>
      <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())} className="secondary-action">
        {pending ? "Updating…" : "Refresh visit"}
      </button>
    </div>
  );
}
