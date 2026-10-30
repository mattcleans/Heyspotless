import Link from "next/link";
import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { listDraftChangeFees } from "@/lib/operations/change-fee-store";
import { changeFeeLabel,type ChangeFeeKind } from "@/lib/operations/change-fee";
import { paymentReviewPage } from "@/lib/billing/review";
import { formatCents } from "@/lib/money";
export const dynamic="force-dynamic";
export const metadata={title:"Change fee review | Hey Spotless Management"};
export default async function FeeInvoicesPage({searchParams}:{searchParams:Promise<{page?:string}>}) {
  const repo=await getRepository(),profile=await repo.getCurrentProfile();
  if(!repo.isDemo && profile?.role!=="admin") notFound();
  const page=paymentReviewPage((await searchParams).page);
  let items:Awaited<ReturnType<typeof listDraftChangeFees>>["items"]=[],total=0,unavailable=false;
  if(!repo.isDemo) try {({items,total}=await listDraftChangeFees(createAdminClient(),page));}catch{unavailable=true;}
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4"><h1 className="text-3xl font-semibold tracking-tight text-navy">Change fees to review</h1><Link className="secondary-action" href="/admin/review">Completed visit review</Link></div>
    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-2">A confirmed cancellation or appointment-day move can create a $60 draft fee. Review the saved change before issuing the bill. Unissued fees are not included in the Client’s balance due.</p>
    {repo.isDemo?<p className="visit-feature mt-5">Live fee drafts are unavailable in demo mode.</p>:unavailable?<p role="alert" className="visit-feature mt-5">Fee drafts could not be loaded. Refresh before relying on this list.</p>:<>
      <p className="mt-5 text-sm text-ink-2">{total} draft {total===1?"fee":"fees"} · oldest first · page {page}</p>
      {items.length?<ul className="mt-4 space-y-3">{items.map(i=><li key={i.id} className="card p-5"><h2 className="font-semibold">{changeFeeLabel(i.kind as ChangeFeeKind)} · {formatCents(i.total_cents)}</h2><p className="mt-2 break-all text-xs text-ink-2">Invoice reference {i.id}</p><Link className="secondary-action mt-3 inline-flex" href={`/admin/invoices/${i.id}`}>Review fee and saved change</Link></li>)}</ul>:<p className="visit-feature mt-4">No draft change fees found on this page.</p>}
      <nav aria-label="Change fee review pages" className="mt-5 flex flex-wrap gap-3">{page>1 && <Link className="secondary-action" href={`/admin/invoices?page=${page-1}`}>Previous page</Link>}{page*25<total && <Link className="secondary-action" href={`/admin/invoices?page=${page+1}`}>Next page</Link>}</nav>
    </>}
    <Link className="secondary-action mt-5 inline-flex" href={`/admin/invoices?page=${page}`}>Refresh fee review</Link>
  </>;
}
