"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { requestServiceDraft, type DraftResult } from "@/lib/operations/invoice-draft-request";

export function ServiceDraftAction({ visitId, priceCents, canPrepare, existingInvoice = false }: { visitId: string; priceCents: number; canPrepare: boolean; existingInvoice?: boolean }) {
  const router = useRouter();
  const locked = useRef(false);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<DraftResult | null>(null);
  async function prepare() {
    if (locked.current || !canPrepare) return;
    locked.current = true; setWorking(true);
    const receipt = await requestServiceDraft(visitId, priceCents);
    setResult(receipt); setWorking(false);
    if (receipt.confirmed) router.refresh();
  }
  if (!canPrepare && !result) return null;
  const href = `/admin/visits/${visitId}`;
  return <div className="mt-4 border-t border-line pt-4">
    {!result && <>
      <p className="max-w-xl text-sm leading-relaxed text-ink-2">{existingInvoice ? "Confirm the existing service invoice so this visit leaves the missing-invoice queue." : `Prepare a service draft at the reviewed visit price of ${formatCents(priceCents)}. Saved photos will be checked again.`} No payment is taken by this action.</p>
      <button type="button" disabled={working || !canPrepare} onClick={prepare} className="mt-3 min-h-11 rounded-full bg-navy px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{working ? "Checking and preparing…" : existingInvoice ? "Confirm invoice record" : "Prepare service draft"}</button>
    </>}
    {result && <div role={result.confirmed ? "status" : "alert"}>
      <p className="text-sm font-semibold text-navy">{result.message}</p>
      {result.confirmed && <><p className="mt-2 text-sm">{formatCents(result.totalCents)} · {result.status === "draft" ? "Draft" : "Existing invoice"}</p><p className="mt-1 break-all text-xs text-ink-2">Invoice reference {result.invoiceId}</p></>}
      <a className="secondary-action mt-3 inline-flex" href={!result.confirmed && result.signIn ? `/login?next=${encodeURIComponent(href)}` : href}>{!result.confirmed && result.signIn ? "Sign in to Management" : "Refresh visit and invoice"}</a>
    </div>}
  </div>;
}
