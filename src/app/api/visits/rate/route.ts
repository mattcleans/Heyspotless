import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoMode } from "@/lib/supabase/env";
import { requestedTipCents } from "@/lib/billing/tip-input";
import { isBillingEnabled } from "@/lib/stripe/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HIGHLIGHTS = new Set([
  "on_time", "thorough", "great_with_pets", "communicated_well", "went_above",
]);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TIP_ERRORS: Record<string, string> = {
  tip_assignment_review: "Your rating was saved. Contact the office to confirm which Cleaner receives the tip.",
  tip_no_invoice: "Your rating was saved. A tip cannot be added until this visit has a bill.",
  tip_invoice_review: "Your rating was saved. Contact the office to review this visit’s bill before adding a tip.",
  tip_payment_in_progress: "Your rating was saved. Finish or cancel the payment already in progress, then return to update the tip.",
  tip_above_price: "Your rating was saved. The tip cannot be more than the clean’s price.",
  tip_settled_review: "Your rating was saved. This Cleaner’s payout has already been settled. Contact the office to add or change a tip.",
  tip_unavailable: "Your rating was saved, but the tip could not be added. Try again or contact the office.",
};

export async function POST(request: NextRequest) {
  if (isDemoMode()) return NextResponse.json({ error: "rating needs a live database" }, { status: 503 });
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  if (profile.role !== "customer") return NextResponse.json({ error: "Client access required" }, { status: 403 });
  const body = await readJson(request);
  const jobId = body.jobId;
  const score = body.score;
  const tipCents = requestedTipCents(body.tipCents);
  if (typeof jobId !== "string" || !UUID.test(jobId) ||
    typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5 || tipCents === null) {
    return NextResponse.json({ error: "A valid visit, a whole-number rating from 1 to 5, and a nonnegative tip in whole cents are required." }, { status: 400 });
  }
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) {
    return NextResponse.json({ error: "Refresh this rating form before saving. Your entries have not been submitted." }, { status: 409 });
  }
  const highlights = Array.isArray(body.highlights)
    ? [...new Set(body.highlights.filter((h): h is string => typeof h === "string" && HIGHLIGHTS.has(h)))] : [];
  const billingEnabled = isBillingEnabled();
  // The database rechecks the trusted actor and locks the owned completed visit.
  // Its tip subtransaction commits invoice + payout together, independently of
  // the rating outcome. No provider charge is issued by this route.
  const { data, error } = await createAdminClient().rpc("record_client_visit_feedback_once", {
    p_submission_id: body.requestId,
    p_profile_id: profile.id, p_job_id: jobId, p_score: score,
    p_comment: text(body.comment), p_highlights: highlights,
    p_private_note: text(body.privateNote), p_tip_cents: billingEnabled ? tipCents : 0,
  });
  if (error) {
    console.error("record_client_visit_feedback_once failed", error.code);
    return NextResponse.json({ error: "Your rating could not be confirmed. Refresh and try again." }, { status: 500 });
  }
  if (!data || typeof data !== "object" || data.recorded !== true) {
    return NextResponse.json({ error: "That completed clean could not be rated. Refresh or contact the office." }, { status: 409 });
  }
  if (tipCents > 0 && !billingEnabled) {
    return NextResponse.json({ recorded: true, tip: null, error: "Online tipping is unavailable. Your rating was saved and no tip was added." }, { status: 409 });
  }
  if (typeof data.tipError === "string") {
    return NextResponse.json({ recorded: true, tip: null, error: TIP_ERRORS[data.tipError] ?? TIP_ERRORS.tip_unavailable }, { status: 409 });
  }
  if (tipCents === 0) return NextResponse.json({ recorded: true, tip: null });
  const tip = data.tip;
  if (!tip || tip.tipCents !== tipCents || !Number.isSafeInteger(tip.feeCents) ||
    !Number.isSafeInteger(tip.netCents) || tip.feeCents < 0 || tip.netCents < 0 ||
    tip.feeCents + tip.netCents !== tipCents) {
    return NextResponse.json({ recorded: true, tip: null, error: "Your rating was saved. Check Account to confirm the tip before trying again." }, { status: 502 });
  }
  return NextResponse.json({ recorded: true, tip });
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value.trim().slice(0, 2000) || null : null;
}
async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch { return {}; }
}
