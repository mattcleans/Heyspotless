import { notFound } from "next/navigation";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { isBillingEnabled } from "@/lib/stripe/env";
import { listPaymentReviews } from "@/lib/billing/review-store";
import { paymentReviewPage, PAYMENT_REVIEW_PAGE_SIZE, type PaymentReviewItem } from "@/lib/billing/review";
import { PaymentReviewList } from "./payment-review-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payment review | Hey Spotless Management" };
export default async function PaymentReviewPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  const demo = isDemoMode();
  if (!demo && profile?.role !== "admin") notFound();
  const page = paymentReviewPage((await searchParams).page);
  let items: PaymentReviewItem[] = [], total = 0, unavailable = false;
  if (!demo) {
    try { ({ items, total } = await listPaymentReviews(await createClient(), page)); }
    catch { unavailable = true; }
  }
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-3xl font-semibold tracking-tight text-navy">Payments to review</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-2">Find the request behind a Client’s payment question. Check its existing status before arranging another payment.</p></div><a href="/admin/payments" className="secondary-action">Refresh list</a></div>
    <p className="my-5 max-w-2xl rounded-xl bg-surface-2 p-4 text-sm leading-relaxed text-ink-2">Checking status reads the existing Stripe request and records a confirmed payment if one is missing here. It does not start a new charge or refund.</p>
    {demo ? <p className="preview-note rounded-xl">Live payment requests are unavailable in demo mode.</p> : unavailable ? <p role="alert" className="visit-feature">Payment requests could not be loaded. Refresh this page before relying on the list.</p> : <>
      {!isBillingEnabled() && <p className="mb-4 text-sm text-ink-2">Payment status checks are inactive in this deployment. You can still review saved requests.</p>}
      <p className="mb-4 text-sm text-ink-2">{total} unresolved {total === 1 ? "request" : "requests"} · oldest first · page {page}</p>
      <PaymentReviewList items={items} enabled={isBillingEnabled()} now={new Date().toISOString()} />
      <nav aria-label="Payment review pages" className="mt-5 flex flex-wrap gap-3">{page > 1 && <a className="secondary-action" href={`/admin/payments?page=${page-1}`}>Previous page</a>}{page * PAYMENT_REVIEW_PAGE_SIZE < total && <a className="secondary-action" href={`/admin/payments?page=${page+1}`}>Next page</a>}</nav>
    </>}
  </>;
}
