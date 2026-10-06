import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toBookingReview } from "./types";
export async function myBookingReviews(db: SupabaseClient) {
  const { data, error } = await db.rpc("read_my_booking_reviews");
  if (error || !Array.isArray(data)) throw new Error("Booking requests are unavailable. Refresh or call the office.");
  return data.map(toBookingReview);
}
