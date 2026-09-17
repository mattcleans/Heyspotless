import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoMode } from "@/lib/supabase/env";

/**
 * How was it.
 *
 * PUBLIC ON PURPOSE, AND THE ONLY PUBLIC WRITE IN THE SYSTEM. The review
 * request is an SMS with a link; a customer who has to sign in to answer "how
 * was it" does not answer it, and a cleaner nobody rates is a cleaner the 3.9
 * eligibility floor cannot judge. The job id stands in for the credential: 122
 * random bits, sent only to the number on the customer's record, good only
 * while the job is complete, and good for exactly one rating because of the
 * unique index that has been on `ratings` since 0001.
 *
 * WHAT A GUESSED ID WOULD BUY. A rating on a stranger's clean, once, with no
 * way to read anything back — the response says nothing about the customer, the
 * address, or the price. That is the whole exposure, and it is the same bargain
 * every one-tap review link makes.
 *
 * The score is clamped in SQL rather than trusted here. A rating of 11 is not
 * enthusiasm, it is somebody editing a request body.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (isDemoMode()) {
    return NextResponse.json({ error: "ratings need a live database" }, { status: 503 });
  }

  const body = await readJson(request);
  const jobId = typeof body["jobId"] === "string" ? body["jobId"] : null;
  const score = typeof body["score"] === "number" ? body["score"] : null;
  const comment =
    typeof body["comment"] === "string" && body["comment"].trim()
      ? body["comment"].trim().slice(0, 2000)
      : null;

  if (!jobId || score === null || !Number.isFinite(score)) {
    return NextResponse.json({ error: "jobId and score are required" }, { status: 400 });
  }
  if (score < 1 || score > 5) {
    return NextResponse.json({ error: "score must be between 1 and 5" }, { status: 400 });
  }

  const { data, error } = await createAdminClient().rpc("record_rating", {
    p_job_id: jobId,
    p_score: score,
    p_comment: comment,
  });

  if (error) {
    console.error("record_rating failed", error);
    return NextResponse.json({ error: "could not record that" }, { status: 500 });
  }

  // Null means the job is not rateable — it does not exist, it is not complete,
  // or nobody was assigned to it. One answer for all three: a probe should not
  // learn which.
  if (typeof data !== "string") {
    return NextResponse.json({ error: "that clean cannot be rated" }, { status: 409 });
  }

  return NextResponse.json({ recorded: true });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
