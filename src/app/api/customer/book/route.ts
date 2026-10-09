import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { runDispatch } from "@/lib/dispatch/run";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { bookingReviewMatches, parseBookingAction, toBookingReview } from "@/lib/booking/types";
export const runtime = "nodejs";
export const maxDuration = 60;
function failure(code?: string) {
  const [status, error] = code === "42501" ? [403, "Use the Client account connected to this home."]
    : code === "PBR01" ? [409, "Continue a saved price review, or let it expire, before starting another."]
    : code === "PBO01" ? [409, "Another visit already uses this time for your home. Check your visits or choose a different time."]
    : code === "PT409" ? [409, "The review changed or expired. Review your choices again before requesting the clean."]
    : ["22023", "23514"].includes(code ?? "") ? [400, "Check your saved home, service, extras and future Dallas appointment."]
    : [503, "We could not confirm the save. Retry the same action to recover its result."];
  return NextResponse.json({ error }, { status: Number(status) });
}
export async function POST(request: NextRequest) {
  const repo = await getRepository(), profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "Sign in again to continue." }, { status: 401 });
  if (profile.role !== "customer") return failure("42501");
  if (repo.isDemo) return NextResponse.json({ error: "Preview requests cannot be saved." }, { status: 409 });
  let body;
  try { body = parseBookingAction(await request.json()); } catch { return failure("22023"); }
  const db = await createClient();
  try {
    const result = body.action === "confirm" ? await db.rpc("confirm_my_booking", { p_id: body.id })
      : await db.rpc("review_my_booking", { p_id: body.id, p_property_id: body.propertyId, p_service: body.service,
          p_freq: body.frequency, p_start: body.start, p_repeats: body.repeats, p_extras: body.extras, p_note: body.note });
    if (result.error) return failure(result.error.code);
    const review = toBookingReview(result.data);
    if (!bookingReviewMatches(body, review)) return failure();
    if (body.action === "confirm" && review.state === "requested" && review.jobId) {
      // The booking is already durable. Matching runs after the response, so
      // a slow or unavailable matcher cannot erase the saved request receipt.
      const jobId = review.jobId, customerProfileId = profile.id, origin = request.nextUrl.origin;
      try {
        after(async () => {
          try { await runDispatch(origin, { jobId, customerProfileId }); }
          catch { console.error(`Automatic matching could not finish for saved visit ${jobId}.`); }
        });
      } catch { console.error(`Automatic matching could not start for saved visit ${jobId}.`); }
    }
    return NextResponse.json(review);
  } catch { return failure(); }
}
