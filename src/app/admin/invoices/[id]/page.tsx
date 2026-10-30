import Link from "next/link";
import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadChangeFeeReview } from "@/lib/operations/change-fee-store";
import { changeFeeLabel,type ChangeFeeReview } from "@/lib/operations/change-fee";
import { isReviewId } from "@/lib/operations/visit-review";
import { ChangeFeeIssueAction } from "@/components/change-fee-issue-action";
import { formatCents } from "@/lib/money";
import { formatDateTimeInZone,todayIn } from "@/lib/time/zone";
export const dynamic="force-dynamic";
export const metadata={title:"Review change fee | Hey Spotless Management"};
export default async function FeeInvoicePage({params}:{params:Promise<{id:string}>}) {
  const repo=await getRepository(),profile=await repo.getCurrentProfile();
  if(!repo.isDemo && profile?.role!=="admin") notFound();
  const {id}=await params;if(!isReviewId(id)) notFound();
  let review:ChangeFeeReview|null=null,unavailable=false;
  if(!repo.isDemo) try {review=await loadChangeFeeReview(createAdminClient(),id);}catch{unavailable=true;}
  if(!repo.isDemo && !unavailable && !review) notFound();
  return <>
    <Link className="secondary-action" href="/admin/invoices">Change fees to review</Link>
    <h1 className="mt-5 text-3xl font-semibold tracking-tight text-navy">Review change fee</h1>
    {repo.isDemo?<p className="visit-feature mt-5">Sample fee invoices cannot be issued.</p>:unavailable?<p className="visit-feature mt-5" role="alert">This fee could not be verified. Refresh before issuing or collecting anything.</p>:review && <>
      <section className="card mt-5 max-w-xl p-5"><h2 className="text-xl font-semibold">{review.customerName}</h2><p className="mt-2">{changeFeeLabel(review.kind)} · {formatCents(review.totalCents)}</p><p className="mt-2 text-sm text-ink-2">Change confirmed {formatDateTimeInZone(new Date(review.changedAt))}</p><p className="mt-3 break-all text-xs text-ink-2">Invoice reference {review.invoiceId}</p><p className="mt-2 break-all text-xs text-ink-2">Change reference {review.changeId}</p><Link className="secondary-action mt-4 inline-flex" href={`/admin/visits/${review.visitId}`}>Review original visit and history</Link></section>
      {review.status==="draft" && !review.issuedAt?<ChangeFeeIssueAction review={review} today={todayIn()}/>:<p role="status" className="visit-feature mt-5">{review.issuedAt?`Invoice issued ${formatDateTimeInZone(new Date(review.issuedAt))}. Check payment status before arranging another payment.`:"This invoice is not available for issuance. Refresh its saved status before proceeding."}</p>}
    </>}
    <Link className="secondary-action mt-5 inline-flex" href={`/admin/invoices/${id}`}>Refresh fee and invoice</Link>
  </>;
}
