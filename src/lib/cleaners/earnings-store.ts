import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toAssignmentPay, toPayRecord } from "./earnings";

export const PAY_RECORD_LIMIT = 200;
const BASE_FIELDS = "id, job_id, amount_cents, mileage_cents, paid_at, created_at, period_start, period_end";
const TIP_FIELDS = "tip_cents, tip_fee_cents, tip_net_cents";
/** Uses the request-scoped client with RLS. No service-role reads. */
export async function loadCleanerPay(db: SupabaseClient, cleanerId: string) {
  if (!cleanerId) throw new Error("Your cleaner profile needs to be connected first.");
  const payouts = (tips: boolean) => db.from("payouts").select(tips ? `${BASE_FIELDS}, ${TIP_FIELDS}` : BASE_FIELDS)
    .eq("cleaner_id", cleanerId).order("created_at", { ascending: false }).order("id").limit(PAY_RECORD_LIMIT);
  const [initial, assignments] = await Promise.all([
    payouts(true),
    db.from("job_assignments").select("job_id, payout_cents, jobs (status, scheduled_start, customers (first_name, last_name), properties (street))")
      .eq("cleaner_id", cleanerId).order("assigned_at", { ascending: false }).order("id").limit(PAY_RECORD_LIMIT),
  ]);
  // Older workspaces have the work/mileage ledger but not tip tracking yet.
  // A missing column is the only condition that permits a partial statement.
  const missingTips = initial.error?.code === "42703" && /tip_(?:net_|fee_)?cents/.test(initial.error.message);
  const result = missingTips ? await payouts(false) : initial;
  if (result.error || assignments.error) throw new Error("Unable to load your pay records. Try again or call the office.");
  return {
    records: (result.data ?? []).map(row => toPayRecord(row as unknown as Record<string, unknown>, !missingTips)),
    assignments: (assignments.data ?? []).map(row => toAssignmentPay(row as unknown as Record<string, unknown>)),
    tipsAvailable: !missingTips,
  };
}
