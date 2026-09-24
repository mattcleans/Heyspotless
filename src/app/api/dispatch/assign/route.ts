import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { assignDemoJob } from "@/lib/demo/added";
import { CLEANER_SHARE_OF_TICKET, payoutForTicket } from "@/lib/pricing/payout";

/**
 * A manager puts a cleaner on a job.
 *
 * The rules live in SQL (`assign_job_manually`, 0029): the eligibility gate,
 * refusing a job somebody already has, withdrawing live offers, and recording
 * the intervention. This proves the caller is an admin and prices the payout
 * the same way the sweep does for a direct assignment.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFUSALS: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: "That job no longer exists." },
  already_assigned: {
    status: 409,
    error: "Somebody already has this job. Refresh to see who.",
  },
  closed: { status: 409, error: "This job has started, finished or been canceled." },
  ineligible: {
    status: 409,
    error: "That cleaner can't take this job (rating, background check, insurance, zone or a clash).",
  },
};

export async function POST(request: NextRequest) {
  const repo = await getRepository();
  const body = await readJson(request);
  const jobId = typeof body["jobId"] === "string" ? body["jobId"] : null;
  const cleanerId = typeof body["cleanerId"] === "string" ? body["cleanerId"] : null;
  if (!jobId || !cleanerId) {
    return NextResponse.json({ error: "jobId and cleanerId are required" }, { status: 400 });
  }

  // Demo mode has no auth and no database; remember it for the session.
  if (repo.isDemo) {
    assignDemoJob(jobId, cleanerId);
    return NextResponse.json({ status: "assigned" });
  }

  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (profile.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can assign cleaners." }, { status: 403 });
  }

  const job = await repo.getJob(jobId);
  if (!job) return NextResponse.json({ error: REFUSALS.not_found!.error }, { status: 404 });

  const { data, error } = await createAdminClient().rpc("assign_job_manually", {
    p_job_id: jobId,
    p_cleaner_id: cleanerId,
    p_payout_cents: payoutForTicket(job.priceCents, CLEANER_SHARE_OF_TICKET),
    p_by: profile.id,
  });

  if (error) {
    console.error("assign_job_manually failed", error);
    return NextResponse.json({ error: "Could not save that. Try again." }, { status: 500 });
  }
  if (data !== "assigned") {
    const refusal = REFUSALS[String(data)] ?? { status: 409, error: "That assignment was refused." };
    return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  }
  return NextResponse.json({ status: "assigned" });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
