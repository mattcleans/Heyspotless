"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { formatCalendarDate, formatDateTimeInZone, toCalendarDate } from "@/lib/time/zone";
import { requestInvoiceIssue, type IssueResult } from "@/lib/operations/invoice-issue-request";

interface Props {
  visitId: string;
  invoiceId: string;
  totalCents: number;
  defaultDueOn: string;
  minDueOn?: string;
}
export function InvoiceIssueAction({ visitId, invoiceId, totalCents, defaultDueOn, minDueOn }: Props) {
  const router = useRouter();
  const locked = useRef(false);
  const [dueOn, setDueOn] = useState(defaultDueOn);
  const [reviewed, setReviewed] = useState(false);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<IssueResult | null>(null);
  const parsedDue = toCalendarDate(dueOn);
  const validDue = parsedDue && (!minDueOn || parsedDue >= minDueOn);
  const href = `/admin/visits/${visitId}`;

  async function issue() {
    if (locked.current || !reviewed || !validDue) return;
    locked.current = true;
    setWorking(true);
    const receipt = await requestInvoiceIssue(visitId, invoiceId, totalCents, dueOn);
    setResult(receipt);
    setWorking(false);
    if (receipt.confirmed) router.refresh();
  }

  return <div className="mt-4 max-w-xl border-t border-line pt-4">
    {!result ? <>
      <h3 className="font-semibold text-navy">Review and issue this invoice</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">
        Issue {formatCents(totalCents)} for this completed visit. The saved price and photo evidence will be checked again.
        This makes an issued bill available in the Client’s account. No automatic payment, email or text is triggered.
      </p>
      <p className="mt-2 break-all text-xs text-ink-2">Invoice reference {invoiceId}</p>
      <label className="mt-3 block text-sm" htmlFor={`due-${invoiceId}`}>Payment due date · Dallas time</label>
      <input className="mt-1 min-h-11 w-full rounded-lg border border-line bg-white px-3 text-sm"
        id={`due-${invoiceId}`} type="date" value={dueOn} min={minDueOn} disabled={working} aria-invalid={!validDue}
        onChange={event => { setDueOn(event.target.value); setReviewed(false); }} />
      {!validDue && <p className="mt-2 text-sm text-ink-2">Choose a valid due date on or after today in Dallas.</p>}
      <label className="mt-3 flex min-h-11 items-start gap-3 py-2 text-sm">
        <input className="mt-1 h-5 w-5 shrink-0" type="checkbox" checked={reviewed} disabled={working}
          onChange={event => setReviewed(event.target.checked)} />
        <span>I reviewed this visit, invoice reference, {formatCents(totalCents)} total and {parsedDue ? formatCalendarDate(parsedDue) : "payment due date"} due date.</span>
      </label>
      <button className="mt-3 min-h-11 rounded-full bg-navy px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        disabled={working || !reviewed || !validDue} onClick={() => void issue()}>
        {working ? "Issuing invoice…" : `Issue invoice for ${formatCents(totalCents)}`}
      </button>
    </> : <div role={result.confirmed ? "status" : "alert"}>
      <p className="font-semibold text-navy">{result.confirmed ? "Invoice issued. No payment was taken by this action." : result.message}</p>
      {result.confirmed && <>
        <p className="mt-2 text-sm">{formatCents(result.receipt.totalCents)} · Due {formatCalendarDate(toCalendarDate(result.receipt.dueOn)!)} · Issued {formatDateTimeInZone(new Date(result.receipt.issuedAt))}</p>
        <p className="mt-1 break-all text-xs text-ink-2">Invoice reference {result.receipt.invoiceId}</p>
      </>}
      <a className="secondary-action mt-3 inline-flex"
        href={!result.confirmed && result.signIn ? `/login?next=${encodeURIComponent(href)}` : href}>
        {!result.confirmed && result.signIn ? "Sign in to Management" : "Refresh visit and invoice"}
      </a>
    </div>}
  </div>;
}
