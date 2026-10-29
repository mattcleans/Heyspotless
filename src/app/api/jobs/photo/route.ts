import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { PhotoReceiptError, ServiceStore } from "@/lib/service/store";
import { invoiceReadiness } from "@/lib/service/completion";
import { readPhotoCapture, type PhotoCaptureReceipt } from "@/lib/service/photo-capture";
import { roomsForVisit } from "@/lib/service/visit-room-scope";

/**
 * Record a photo the phone has already uploaded to storage.
 *
 * The bytes do not come through here. The client puts the image in Supabase
 * Storage and posts the path, which keeps a twenty-photo job off a serverless
 * function with a request size limit and a timeout.
 *
 * SAFE TO REPLAY, deliberately: the offline queue retries, and a cleaner who
 * loses signal mid-upload must be able to drain it later without billing the
 * customer twice. A capture receipt binds its revision, byte hash and exact object version;
 * a delayed older capture cannot replace a later retake. Invoicing is guarded separately.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const capture = readPhotoCapture(await readJson(request));
  if (!capture) return NextResponse.json({ recorded: false, message: "Refresh this visit before retrying. Keep the saved photo copy." }, { status: 409 });
  const { jobId } = capture;

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  if (profile.role !== "cleaner") return NextResponse.json({ recorded: false, error: "Cleaner access required" }, { status: 403 });

  const cleaner = await repo.getCleanerByProfile(profile.id);
  if (!cleaner) return NextResponse.json({ error: "no cleaner record" }, { status: 403 });

  const store = new ServiceStore(createAdminClient());
  let receipt: PhotoCaptureReceipt | null;
  try { receipt = await store.recordPhoto({ ...capture, cleanerId: cleaner.id }); } catch (error) {
    return NextResponse.json({ recorded: false, message: error instanceof PhotoReceiptError ? error.message : "The photo receipt could not be confirmed. Keep the saved copy and try again." }, { status: error instanceof PhotoReceiptError ? 409 : 503 });
  }
  if (!receipt) return NextResponse.json({ recorded: false, message: "The photo receipt could not be confirmed. Keep the saved copy and refresh this visit." }, { status: 409 });

  // What is still outstanding, so the queue can tell her rather than leaving
  // her to count.
  const job = await repo.getJob(jobId);
  const counts = job ? roomsForVisit(job) : null;
  const photos = await store.photosFor(jobId);
  const readiness = job && counts
    ? invoiceReadiness(job.status, counts, photos)
    : { ready: false as const, reason: "not_complete" as const };

  return NextResponse.json({
    ...receipt,
    billable: readiness.ready,
    requirementsAvailable: counts !== null,
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
