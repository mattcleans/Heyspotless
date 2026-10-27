import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PAYMENT_REVIEW_PAGE_SIZE, type PaymentReviewItem } from "./review";

/** Uses the signed-in user's client; invoice and Client RLS still apply. */
export async function listPaymentReviews(db: SupabaseClient, page: number) {
  const from = (page - 1) * PAYMENT_REVIEW_PAGE_SIZE;
  const { data, error, count } = await db.from("payment_operations")
    .select("id,invoice_id,channel,state,amount_cents,stripe_object_id,idempotency_key,created_at,expires_at,invoices!inner(id,customer_id,job_id,balance_cents,customers!inner(first_name,last_name))", { count: "exact" })
    .in("state", ["open", "abandoned"])
    .order("created_at", { ascending: true }).order("id", { ascending: true })
    .range(from, from + PAYMENT_REVIEW_PAGE_SIZE - 1);
  if (error || count === null) throw new Error("Payment review list unavailable");
  const items: PaymentReviewItem[] = (data ?? []).map(raw => {
    const row = raw as unknown as {
      id: string; invoice_id: string; channel: "checkout" | "autocharge";
      state: "open" | "abandoned"; amount_cents: number; stripe_object_id: string | null;
      idempotency_key: string; created_at: string; expires_at: string;
      invoices: { customer_id: string; job_id: string | null; balance_cents: number; customers: { first_name: string; last_name: string } };
    };
    return {
      id: row.id, invoiceId: row.invoice_id, customerId: row.invoices.customer_id,
      customerName: `${row.invoices.customers.first_name} ${row.invoices.customers.last_name}`.trim(),
      jobId: row.invoices.job_id, amountCents: row.amount_cents, balanceCents: row.invoices.balance_cents,
      createdAt: row.created_at, expiresAt: row.expires_at, channel: row.channel, state: row.state,
      providerReference: row.stripe_object_id, requestReference: row.idempotency_key,
    };
  });
  return { items, total: count };
}
