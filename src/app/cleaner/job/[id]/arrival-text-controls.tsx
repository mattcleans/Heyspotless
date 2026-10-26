"use client";
import { useEffect, useState } from "react";
import { requestArrivalText } from "./arrival-text-request";
import type { ArrivalTextReceipt } from "@/lib/messaging/arrival-receipt";

export function ArrivalTextControls({ jobId }: { jobId: string }) {
  const [receipt, setReceipt] = useState<ArrivalTextReceipt | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    void requestArrivalText(jobId, "GET", abort.signal).then(value => { if (active) setReceipt(value); });
    return () => { active = false; abort.abort(); };
  }, [jobId]);
  async function act() {
    if (!receipt || working) return;
    setWorking(true);
    setReceipt(await requestArrivalText(jobId, receipt.state === "not_requested" ? "POST" : "GET"));
    setWorking(false);
  }
  return <ArrivalTextStatus receipt={receipt} working={working} jobId={jobId} onAction={() => void act()} />;
}

export function ArrivalTextStatus({ receipt, working, jobId, onAction }: {
  receipt: ArrivalTextReceipt | null; working: boolean; jobId: string; onAction: () => void;
}) {
  const label = !receipt ? "Checking text status…" : working ? (receipt.state === "not_requested" ? "Requesting text…" : "Checking…") : receipt.state === "accepted" ? "Text submitted"
    : receipt.state === "not_requested" ? "On my way" : receipt.state === "unconfirmed" ? "Check text status" : "Arrival text unavailable";
  return <section className="mt-6" aria-label="Arrival text">
    <button type="button" onClick={onAction} disabled={!receipt || working || (receipt.state !== "not_requested" && receipt.state !== "unconfirmed")}
      aria-busy={!receipt || working} className="min-h-11 w-full rounded-lg border border-navy px-4 py-3 text-sm font-semibold text-navy disabled:opacity-60">{label}</button>
    {receipt?.message && <p role="status" className="mt-3 text-sm leading-relaxed text-ink-2">{receipt.message}</p>}
    {receipt && receipt.state !== "accepted" && receipt.state !== "not_requested" && <div className="mt-2 flex flex-wrap gap-2">
      {receipt.state === "sign_in" ? <a className="secondary-action" href={`/login?next=${encodeURIComponent(`/cleaner/job/${jobId}`)}`}>Sign in again</a>
        : <a className="secondary-action" href="tel:+14692800397">Call the office</a>}
      <a className="secondary-action" href={`/cleaner/job/${jobId}`}>Refresh visit</a>
    </div>}
  </section>;
}
