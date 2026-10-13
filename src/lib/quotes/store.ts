import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toClientQuote } from "./types";
export async function readClientQuotes(
  db: SupabaseClient,
  customerId: string | null = null,
) {
  const { data, error } = await db.rpc("read_client_quotes", {
    p_customer_id: customerId,
  });
  if (error || !Array.isArray(data))
    throw new Error("Quotes are unavailable. Refresh or call the office.");
  return data.map(toClientQuote);
}
