import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toCrewReceipt, toCrewReview } from "./types";
export async function crewReview(db: SupabaseClient, id: string) {
  const { data, error } = await db.rpc("read_crew_lead_review", {
    p_job_id: id,
  });
  if (error)
    throw new Error(
      "Crew details are unavailable. Refresh and review the visit.",
    );
  return toCrewReview(data);
}
export async function myCrewOffers(db: SupabaseClient) {
  const { data, error } = await db.rpc("read_my_crew_lead_offers");
  if (error?.code === "PGRST202" || error?.code === "42883") return [];
  if (error || !Array.isArray(data))
    throw new Error(
      "Replacement offers are unavailable. Refresh or call the office.",
    );
  return data.map(toCrewReceipt);
}
