"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCents } from "@/lib/money";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { paymentReleasable, paymentReleaseReady, paymentReviewReason, type PaymentReviewItem } from "@/lib/billing/review";
import { fetchWithTimeout } from "@/lib/http/fetch-with-timeout";

export function PaymentReviewList({ items, enabled, now }: { items: PaymentReviewItem[]; enabled: boolean; now: string }) {
  const router = useRouter();
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  async function check(item: PaymentReviewItem) {
    setWorking(item.id); setNotice(null);
    try {
      const response = await fetchWithTimeout("/api/billing/reconcile", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoiceId: item.invoiceId }),
      });
      const data: unknown = await response.json();
      const message = data && typeof data === "object" && "message" in data && typeof data.message === "string" ? data.message : null;
      if (!message) throw new Error("Unconfirmed response");
      setNotice({ message: `${item.customerName}: ${message}`, error: !response.ok });
      if (response.ok) router.refresh();
    } catch {
      setNotice({ message: "The status check could not be confirmed. Refresh the list before arranging another payment.", error: true });
    } finally { setWorking(null); }
  }
  async function release(item: PaymentReviewItem) {
    setWorking(item.id); setNotice(null);
    try {
      const response = await fetchWithTimeout("/api/billing/release", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: item.id, confirmedNoCharge: true }),
      });
      const data: unknown = await response.json();
      const message = data && typeof data === "object" && "message" in data && typeof data.message === "string" ? data.message : null;
      if (!message) throw new Error("Unconfirmed response");
      setNotice({ message: `${item.customerName}: ${message}`, error: !response.ok });
      if (response.ok) router.refresh();
    } catch {
      setNotice({ message: "The release could not be confirmed. Refresh the list before trying again.", error: true });
    } finally { setWorking(null); }
  }
  return <>
    {notice && <p role={notice.error ? "alert" : "status"} className="mb-5 rounded-xl border border-line bg-white p-4 text-sm leading-relaxed">{notice.message}</p>}
    {!items.length ? <section className="visit-feature"><h2 className="font-semibold text-navy">No unresolved requests on this page</h2><p className="mt-2 text-sm text-ink-2">This list tracks open and older unconfirmed requests. It does not mean every invoice is paid.</p></section> :
      <ul className="divide-y divide-line rounded-xl border border-line bg-white">
        {items.map(item => <li key={item.id} className="p-5 sm:p-6">
          <div className="flex flex-wrap justify-between gap-3">
            <div><h2 className="text-lg font-semibold text-navy">{item.customerName || "Client"}</h2><p className="mt-1 text-sm text-ink-2">Invoice {item.invoiceId.slice(0, 8)}</p></div>
            <div className="sm:text-right"><p className="text-xl font-semibold tabular-nums text-navy">{formatCents(item.amountCents)}</p><p className="mt-1 text-xs text-ink-2">Requested · current balance {formatCents(item.balanceCents)}</p></div>
          </div>
          <p className="mt-4 border-l-4 border-cream pl-3 text-sm font-semibold text-ink">{paymentReviewReason(item, new Date(now))}</p>
          <p className="mt-2 text-sm text-ink-2">Requested {formatDateTimeInZone(new Date(item.createdAt))} Dallas time · {item.channel === "checkout" ? "Client payment" : "Automatic payment"}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Link className="secondary-action" href={`/admin/customers/${item.customerId}`}>Client details</Link>
            {item.jobId && <Link className="secondary-action" href={`/admin/visits/${item.jobId}`}>Visit details</Link>}
            {item.state === "open" && item.providerReference && <button type="button" className="min-h-11 rounded-full bg-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={!enabled || working !== null} onClick={() => check(item)}>{working === item.id ? "Checking…" : "Check payment status"}</button>}
          </div>
          {paymentReleasable(item) && <div className="mt-3 max-w-2xl space-y-3 text-sm leading-relaxed text-ink-2">
            <p>Find this request in Stripe and confirm its outcome before collecting again. An elapsed deadline alone does not confirm that it failed. If Stripe shows a charge for it, do not release this request.</p>
            {paymentReleaseReady(item, new Date(now)) ? <>
              <label className="flex min-h-11 items-start gap-3"><input type="checkbox" className="mt-1" checked={confirmed[item.id] === true} disabled={working !== null} onChange={e => setConfirmed(c => ({ ...c, [item.id]: e.target.checked }))} /><span>I searched Stripe for this request reference and found no charge or payment.</span></label>
              <button type="button" className="secondary-action disabled:opacity-50" disabled={confirmed[item.id] !== true || working !== null} onClick={() => release(item)}>{working === item.id ? "Releasing…" : "Release request"}</button>
            </> : <p>This request can be released 30 minutes after it started, once any late Stripe update has had time to arrive.</p>}
          </div>}
          <details className="mt-3 text-sm text-ink-2"><summary className="min-h-11 cursor-pointer py-3 font-semibold text-navy">Request details for Stripe review</summary><dl className="space-y-2 break-all rounded-lg bg-ground p-3"><div><dt className="font-semibold">Provider reference</dt><dd>{item.providerReference ?? "Not saved"}</dd></div><div><dt className="font-semibold">Request reference</dt><dd>{item.requestReference}</dd></div></dl></details>
        </li>)}
      </ul>}
  </>;
}
