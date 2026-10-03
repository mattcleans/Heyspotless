import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toCancellationReceipt } from "./types";
export async function loadCancellation(db: SupabaseClient, jobId: string) {
  const { data, error } = await db
    .from("visit_cancellations")
    .select(
      "id,job_id,reason,scheduled_start,fee_cents,invoice_id,billing_review,canceled_at",
    )
    .eq("job_id", jobId)
    .maybeSingle();
  if (error)
    throw new Error(
      "Cancellation details are unavailable. Refresh or call the office.",
    );
  return data ? toCancellationReceipt(data) : null;
}
export async function loadCancellationVisit(db: SupabaseClient, id: string) {
  const { data, error } = await db.rpc("read_my_visit_schedule_identity", {
    p_job: id,
  });
  if (
    error ||
    !data ||
    typeof data.status !== "string" ||
    typeof data.recurring !== "boolean"
  )
    throw new Error(
      "Visit details are unavailable. Refresh or call the office.",
    );
  return {
    closed:
      !["unscheduled", "scheduled", "dispatching", "assigned"].includes(
        data.status,
      ) || data.started_at !== null,
    recurring: data.recurring,
  };
}
export async function listCancellations(db: SupabaseClient) {
  const { data, error } = await db
    .from("visit_cancellations")
    .select(
      "id,job_id,reason,scheduled_start,fee_cents,invoice_id,billing_review,canceled_at",
    )
    .order("canceled_at", { ascending: false })
    .limit(100);
  if (error || !Array.isArray(data))
    throw new Error(
      "Cancellation records could not be loaded. Refresh before reviewing billing.",
    );
  return data.map(toCancellationReceipt);
}
export async function cancellationsForInvoices(
  db: SupabaseClient,
  jobIds: string[],
) {
  if (!jobIds.length) return [];
  const { data, error } = await db
    .from("visit_cancellations")
    .select(
      "id,job_id,reason,scheduled_start,fee_cents,invoice_id,billing_review,canceled_at",
    )
    .in("job_id", [...new Set(jobIds)]);
  // Existing accounts stay usable before this release's migration is applied.
  if (error && ["42P01", "PGRST205"].includes(error.code)) return null;
  if (error || !Array.isArray(data))
    throw new Error(
      "Cancellation billing details are unavailable. Refresh before paying.",
    );
  return data.map(toCancellationReceipt);
}
