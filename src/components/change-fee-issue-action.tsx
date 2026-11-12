"use client";
import { useRef,useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { formatCalendarDate,toCalendarDate } from "@/lib/time/zone";
import { fetchWithTimeout } from "@/lib/http/fetch-with-timeout";
import { changeFeeLabel,readChangeFeeReceipt,type ChangeFeeReview,type ChangeFeeReceipt } from "@/lib/operations/change-fee";
export function ChangeFeeIssueAction({review,today}:{review:ChangeFeeReview;today:string}) {
  const router=useRouter(),locked=useRef(false);
  const [dueOn,setDueOn]=useState(review.dueOn && review.dueOn>=today?review.dueOn:today);
  const [checked,setChecked]=useState(false),[working,setWorking]=useState(false);
  const [result,setResult]=useState<{receipt?:ChangeFeeReceipt;message:string;signIn?:boolean}|null>(null);
  const due=toCalendarDate(dueOn),valid=due && due>=today;
  const href=`/admin/invoices/${review.invoiceId}`;
  async function issue(){
    if(locked.current || !checked || !valid) return;
    locked.current=true;setWorking(true);
    try {
      const response=await fetchWithTimeout(`/api/admin/invoices/${review.invoiceId}/issue`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({changeId:review.changeId,kind:review.kind,reviewedTotalCents:review.totalCents,dueOn,confirmed:true})});
      const value:unknown=await response.json();
      if(response.status===401){setResult({message:"Sign in to Management and reopen this fee.",signIn:true});return;}
      const receipt=response.ok?readChangeFeeReceipt(value,{...review,dueOn}):null;
      if(receipt){setResult({receipt,message:"Fee invoice issued. No payment was taken."});router.refresh();}
      else setResult({message:response.status===409?"The fee changed. Refresh and review it again.":"Issuance could not be confirmed. Refresh this fee before trying again."});
    }catch{setResult({message:"Issuance could not be confirmed. Refresh this fee before trying again."});}
    finally{setWorking(false);}
  }
  return <section className="visit-feature mt-5 max-w-xl">
    {result?<div role={result.receipt?"status":"alert"}><p className="font-semibold">{result.message}</p>{result.receipt && <p className="mt-2 text-sm">{formatCents(result.receipt.totalCents)} · Due {formatCalendarDate(toCalendarDate(result.receipt.dueOn)!)}</p>}<a className="secondary-action mt-3 inline-flex" href={result.signIn?`/login?next=${encodeURIComponent(href)}`:href}>{result.signIn?"Sign in to Management":"Refresh fee and invoice"}</a></div>:<>
      <h2 className="font-semibold text-navy">Review and issue this fee</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">Issue {formatCents(review.totalCents)} for this confirmed change. It will appear as a bill in the Client’s account. This action sends no email or text and takes no payment. Fees do not require cleaning photos.</p>
      <label className="mt-4 block text-sm" htmlFor="fee-due">Payment due date · Dallas time</label><input id="fee-due" type="date" className="mt-1 min-h-11 w-full rounded-lg border border-line bg-white px-3" min={today} value={dueOn} disabled={working} aria-invalid={!valid} onChange={event=>{setDueOn(event.target.value);setChecked(false);}} />
      {!valid && <p className="mt-2 text-sm">Choose a valid due date on or after today in Dallas.</p>}
      <label className="mt-3 flex min-h-11 items-start gap-3 py-2 text-sm"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={checked} disabled={working} onChange={e=>setChecked(e.target.checked)}/><span>I reviewed {review.customerName}’s {changeFeeLabel(review.kind).toLowerCase()}, the saved change and invoice references, {formatCents(review.totalCents)} total and {due?formatCalendarDate(due):"payment due date"} due date.</span></label>
      <button className="mt-3 min-h-11 rounded-full bg-navy px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50" disabled={working || !checked || !valid} onClick={()=>void issue()}>{working?"Issuing fee…":`Issue fee invoice for ${formatCents(review.totalCents)}`}</button>
    </>}
  </section>;
}
