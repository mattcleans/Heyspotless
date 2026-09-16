import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { ServiceStore } from "@/lib/service/store";
import { invoiceReadiness } from "@/lib/service/completion";

/**
 * Record a photo the phone has already uploaded to storage.
 *
 * The bytes do not come through here. The client puts the image in Supabase
 * Storage and posts the path, which keeps a twenty-photo job off a serverless
 * function with a request size limit and a timeout.
 *
 * SAFE TO REPLAY, deliberately: the offline queue retries, and a cleaner who
 * loses signal mid-upload must be able to drain it later without billing the
 * customer twice. `record_job_photo` is idempotent per (job, room, kind), and
 * raising the invoice is guarded separately.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set(["before", "after", "issue"]);

export async function POST(request: NextRequest) {
  const body = await readJson(request);

  const jobId = typeof body["jobId"] === "string" ? body["jobId"] : null;
  const storagePath = typeof body["storagePath"] === "string" ? body["storagePath"] : null;
  const kind = typeof body["kind"] === "string" ? body["kind"] : null;
  const roomKey = typeof body["roomKey"] === "string" ? body["roomKey"] : null;

  if (!jobId || !storagePath || !kind || !roomKey || !KINDS.has(kind)) {
    return NextResponse.json(
      { error: "jobId, storagePath, roomKey and a kind of before/after/issue are required" },
      { status: 400 },
    );
  }

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const cleaner = await repo.getCleanerByProfile(profile.id);
  if (!cleaner) return NextResponse.json({ error: "no cleaner record" }, { status: 403 });

  const store = new ServiceStore(createAdminClient());
  await store.recordPhoto({
    jobId,
    cleanerId: cleaner.id,
    storagePath,
    kind: kind as "before" | "after" | "issue",
    roomKey,
  });

  // What is still outstanding, so the queue can tell her rather than leaving
  // her to count.
  const job = await repo.getJob(jobId);
  const photos = await store.photosFor(jobId);
  const readiness = job
    ? invoiceReadiness(job.status, { bedrooms: job.bedrooms, bathrooms: job.bathrooms }, photos)
    : { ready: false as const, reason: "not_complete" as const };

  return NextResponse.json({
    recorded: true,
    billable: readiness.ready,
    outstanding:
      readiness.ready || readiness.reason !== "photos_outstanding"
        ? []
        : readiness.gaps.map((gap) => ({
            room: gap.room.key,
            label: gap.room.label,
            missing: gap.missing,
          })),
  });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
