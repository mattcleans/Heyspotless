import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { ServiceStore } from "@/lib/service/store";
import { invoiceReadiness } from "@/lib/service/completion";

/**
 * The cleaner taps done.
 *
 * COMPLETION IS NEVER BLOCKED BY THE EVIDENCE. She has left, the house is
 * clean, and nothing here should stop her closing out her day. The response
 * tells her what photos are still outstanding so she knows the job is not yet
 * billable, but the job is complete either way.
 *
 * Location is optional and is used to compute a distance, not stored as a
 * coordinate — an attestation that she was there when she said she was, not a
 * record of where a contractor has been.
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

  const cleaner = await repo.getCleanerByProfile(profile.id);
  if (!cleaner) return NextResponse.json({ error: "no cleaner record" }, { status: 403 });

  const at = readCoordinate(body["location"]);
  const store = new ServiceStore(createAdminClient());

  if (!(await store.complete(jobId, cleaner.id, at))) {
    // Not hers, or not in a state that can finish. Deliberately the same
    // answer for both: an id someone is guessing at should not learn which.
    return NextResponse.json(
      { error: "that job cannot be completed" },
      { status: 409 },
    );
  }

  const job = await repo.getJob(jobId);
  const photos = await store.photosFor(jobId);
  const readiness = job
    ? invoiceReadiness("complete", { bedrooms: job.bedrooms, bathrooms: job.bathrooms }, photos)
    : { ready: false as const, reason: "not_complete" as const };

  return NextResponse.json({
    completed: true,
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

/** A coordinate, or null. Anything malformed is treated as no fix at all. */
function readCoordinate(value: unknown): { lat: number; lng: number } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { lat?: unknown; lng?: unknown };
  if (typeof raw.lat !== "number" || typeof raw.lng !== "number") return null;
  if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lng)) return null;
  if (Math.abs(raw.lat) > 90 || Math.abs(raw.lng) > 180) return null;
  return { lat: raw.lat, lng: raw.lng };
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
