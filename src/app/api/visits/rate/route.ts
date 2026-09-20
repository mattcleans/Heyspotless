import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { tipPassThrough } from "@/lib/billing/tips";

/**
 * Screen 7, submitted: the rating, what stood out, a private note, and a tip.
 *
 * THE TIP IS THE PART TO BE CAREFUL WITH. Three things happen, in this order,
 * and the order is the point:
 *
 *   1. The rating is recorded. It is what the customer came to do, it feeds
 *      the eligibility gate, and it must not be lost because a tip failed.
 *   2. The tip goes on the invoice, so every path that collects a balance —
 *      Checkout, the autocharge sweep — collects it. A tip that is not on the
 *      invoice by the time the sweep runs is a tip nobody ever charges for.
 *   3. The payout split is recorded: what the card costs, and what reaches
 *      her. Written together so the money always reconciles.
 *
 * WHOSE CLEAN IT IS, is answered by row-level security rather than by trusting
 * the id in the body — the ownership check reads `jobs` as the signed-in
 * customer, so a job that is not theirs simply is not there.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Matches the chips on the screen. Anything else is somebody else's payload. */
const HIGHLIGHTS = new Set([
  "on_time",
  "thorough",
  "great_with_pets",
  "communicated_well",
  "went_above",
]);

export async function POST(request: NextRequest) {
  if (isDemoMode()) {
    return NextResponse.json({ error: "rating needs a live database" }, { status: 503 });
  }

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = await readJson(request);
  const jobId = typeof body["jobId"] === "string" ? body["jobId"] : null;
  const score = typeof body["score"] === "number" ? body["score"] : null;

  if (!jobId || score === null || !Number.isFinite(score) || score < 1 || score > 5) {
    return NextResponse.json({ error: "a job and a score of 1 to 5 are required" }, { status: 400 });
  }

  // Theirs? RLS answers it: `messages_own`-style policies on jobs mean a job
  // belonging to somebody else returns no row at all.
  const asCustomer = await createClient();
  const { data: owned } = await asCustomer.from("jobs").select("id").eq("id", jobId).maybeSingle();
  if (!owned) return NextResponse.json({ error: "that clean is not yours" }, { status: 409 });

  const tipCents =
    typeof body["tipCents"] === "number" && Number.isFinite(body["tipCents"])
      ? Math.max(0, Math.round(body["tipCents"]))
      : 0;

  const highlights = Array.isArray(body["highlights"])
    ? (body["highlights"] as unknown[])
        .filter((h): h is string => typeof h === "string" && HIGHLIGHTS.has(h))
        .slice(0, HIGHLIGHTS.size)
    : [];

  const privateNote = text(body["privateNote"]);
  const comment = text(body["comment"]);

  const db = createAdminClient();

  // ---- 1. the rating ------------------------------------------------------
  const { data: ratingId, error: ratingError } = await db.rpc("record_rating_detailed", {
    p_job_id: jobId,
    p_score: score,
    p_comment: comment,
    p_highlights: highlights,
    p_private_note: privateNote,
  });

  if (ratingError) {
    console.error("record_rating_detailed failed", ratingError);
    return NextResponse.json({ error: "could not record that" }, { status: 500 });
  }
  if (typeof ratingId !== "string") {
    return NextResponse.json({ error: "that clean cannot be rated" }, { status: 409 });
  }

  if (tipCents === 0) return NextResponse.json({ recorded: true, tip: null });

  // ---- 2. the tip, on the bill -------------------------------------------
  const { data: invoice } = await db
    .from("invoices")
    .select("id")
    .eq("job_id", jobId)
    .is("voided_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const invoiceId = (invoice as Record<string, unknown> | null)?.["id"];

  if (typeof invoiceId === "string") {
    const { error } = await db.rpc("set_invoice_tip", {
      p_invoice_id: invoiceId,
      p_tip_cents: tipCents,
    });

    if (error) {
      // The ceiling, almost always: a tip larger than the work it thanks. The
      // rating is already saved, so this is a partial success and says so
      // rather than pretending the whole submission failed.
      return NextResponse.json(
        { recorded: true, tip: null, error: "that tip could not be added to your bill" },
        { status: 409 },
      );
    }
  }

  // ---- 3. the split -------------------------------------------------------
  const split = tipPassThrough(tipCents);
  const { error: payoutError } = await db.rpc("record_tip_payout", {
    p_job_id: jobId,
    p_tip_cents: tipCents,
  });

  if (payoutError) {
    // The customer will be charged the tip either way, so a payout row that
    // failed to write is money owed to a cleaner with nothing pointing at it.
    // Loud, never silent.
    console.error("record_tip_payout failed", payoutError);
    return NextResponse.json({
      recorded: true,
      tip: split,
      warning: "the payout record needs checking",
    });
  }

  return NextResponse.json({ recorded: true, tip: split });
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 2000) : null;
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
