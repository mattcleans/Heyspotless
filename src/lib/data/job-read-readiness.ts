import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { JOB_SELECT } from "./supabase-repository";

/** Resolve the actual dispatch projection without fetching or changing business rows. */
export async function isJobReadReady(db: SupabaseClient): Promise<boolean> {
  try {
    const { error } = await db.from("jobs").select(JOB_SELECT).limit(0)
      .abortSignal(AbortSignal.timeout(5_000));
    return error === null;
  } catch {
    // Health reports capability only, never upstream headers or error payloads.
    return false;
  }
}
