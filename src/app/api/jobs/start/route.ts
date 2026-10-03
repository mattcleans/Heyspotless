import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { BackupApprovalRequired, ServiceStore } from "@/lib/service/store";
import { roomsFor } from "@/lib/service/rooms";

/**
 * The cleaner arrives and starts.
 *
 * `in_progress` stops being a state the system skips, because a BEFORE photo
 * has to be taken before the clean. Arrival time comes free with it, and is a
 * real operational signal — the gap between scheduled and actual start is the
 * first thing anybody asks about a late job.
 *
 * The response carries the room list so her phone knows what to photograph
 * without working it out from a property record it would otherwise have to
 * fetch and interpret.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await readJson(request);
  const jobId = typeof body["jobId"] === "string" ? body["jobId"] : null;
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  if (profile.role !== "cleaner") return NextResponse.json({ error: "Cleaner access required" }, { status: 403 });
  const cleaner = await repo.getCleanerByProfile(profile.id);
  if (!cleaner) return NextResponse.json({ error: "no cleaner record" }, { status: 403 });

  const store = new ServiceStore(createAdminClient());
  let saved;
  try { saved = await store.start(jobId, cleaner.id); }
  catch (error) {
    if (error instanceof BackupApprovalRequired) return NextResponse.json({ error:error.message, code:"backup_approval_required" },{status:409});
    throw error;
  }
  if (!saved) {
    return NextResponse.json({ error: "that job cannot be started" }, { status: 409 });
  }

  const job = await repo.getJob(jobId);
  const rooms = job ? roomsFor({ bedrooms: job.bedrooms, bathrooms: job.bathrooms }) : [];

  return NextResponse.json({ started: true, rooms });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
