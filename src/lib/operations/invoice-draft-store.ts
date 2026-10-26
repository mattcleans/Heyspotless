import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export class DraftPriceChanged extends Error {}

/** Called only after the request's Management role and visit read are checked. */
export async function prepareServiceDraft(db: SupabaseClient, jobId: string, reviewedPriceCents: number): Promise<string | null> {
  const { data, error } = await db.rpc("prepare_job_service_draft", {
    p_job_id: jobId, p_reviewed_price_cents: reviewedPriceCents,
  });
  if (error?.code === "PFD01") throw new DraftPriceChanged();
  if (error) throw new Error("The service draft could not be confirmed.");
  return typeof data === "string" ? data : null;
}
