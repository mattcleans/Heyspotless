import "server-only";

import { readPhotoCaptureReceipt, type PhotoCapture, type PhotoCaptureReceipt } from "./photo-capture";
import { verifyPhotoObject } from "./photo-object-proof";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Starting, finishing and photographing a job.
 *
 * Same division as everywhere else: what counts as finished and what may be
 * billed are decided by the pure functions in completion.ts; this executes
 * them. Service-role, because every one of these functions checks for itself
 * that the caller is the cleaner the job was assigned to rather than trusting
 * a client-supplied id.
 */
export class BackupApprovalRequired extends Error {
  constructor() { super("The client must approve this backup before work starts. Refresh this visit or contact the office."); }
}

export class PhotoReceiptError extends Error {
  constructor() { super("The photo could not be confirmed for this visit. Keep the saved copy and refresh the visit or contact the office."); }
}

export class ServiceStore {
  constructor(private readonly db: SupabaseClient) {}

  /** She has arrived. Idempotent — a second tap does not move the arrival. */
  async start(jobId: string, cleanerId: string): Promise<boolean> {
    const { data, error } = await this.db.rpc("start_job", {
      p_job_id: jobId,
      p_cleaner_id: cleanerId,
    });
    if (error?.code === "PBC01") throw new BackupApprovalRequired();
    if (error) throw new Error(`start: ${error.message}`);
    return data === true;
  }

  /**
   * She has finished.
   *
   * The coordinate is passed for the distance to be computed FROM, and is not
   * stored. Absent is ordinary and never blocks: cleaners work indoors, which
   * is where a fix is worst.
   */
  async complete(
    jobId: string,
    cleanerId: string,
    at: { lat: number; lng: number } | null = null,
  ): Promise<boolean> {
    const { data, error } = await this.db.rpc("complete_job", {
      p_job_id: jobId,
      p_cleaner_id: cleanerId,
      p_lat: at?.lat ?? null,
      p_lng: at?.lng ?? null,
    });
    if (error?.code === "PBC01") throw new BackupApprovalRequired();
    if (error) throw new Error(`complete: ${error.message}`);
    return data === true;
  }

  /**
   * Record a photo, and raise the invoice if it was the last one needed.
   *
   * One call rather than two, so the gate cannot drift out of step with the
   * evidence: a photo recorded without re-checking leaves a job uninvoiced
   * until something else happens to look at it.
   */
  async recordPhoto(input: PhotoCapture & { cleanerId: string }): Promise<PhotoCaptureReceipt | null> {
    const { data: candidate, error: candidateError } = await this.db.rpc("job_photo_upload_candidate", {
      p_job: input.jobId, p_cleaner: input.cleanerId, p_path: input.storagePath,
      p_room: input.roomKey, p_kind: input.kind, p_revision: input.revision,
    });
    if (candidateError || !candidate || typeof candidate !== "object" ||
        typeof candidate.objectId !== "string" || typeof candidate.objectVersion !== "string" ||
        !candidate.objectVersion || !Number.isSafeInteger(candidate.byteSize) || candidate.byteSize <= 0) throw new PhotoReceiptError();
    const { data: signed, error: signedError } = await this.db.storage.from("job-photos").createSignedUrl(input.storagePath, 60);
    if (signedError || !signed?.signedUrl) throw new PhotoReceiptError();
    try { await verifyPhotoObject(signed.signedUrl, input.sha256, candidate.byteSize); }
    catch { throw new PhotoReceiptError(); }
    const { data, error } = await this.db.rpc("record_job_photo_capture", {
      p_job: input.jobId, p_cleaner: input.cleanerId, p_path: input.storagePath,
      p_room: input.roomKey, p_kind: input.kind, p_revision: input.revision,
      p_sha256: input.sha256, p_supersedes: input.supersedes,
      p_object: candidate.objectId, p_object_version: candidate.objectVersion,
      p_byte_size: candidate.byteSize,
    });
    if (error) throw new PhotoReceiptError();
    return readPhotoCaptureReceipt(data, input);
  }

  /** The photos already in for a job, for working out what is outstanding. */
  async photosFor(jobId: string): Promise<{ roomKey: string | null; kind: string; revision?: string }[]> {
    const { data, error } = await this.db.rpc("verified_job_photos", { p_job: jobId });
    if (error) throw new Error(`photosFor: ${error.message}`);

    return (Array.isArray(data) ? data : []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        roomKey: typeof r["room_key"] === "string" ? r["room_key"] : null,
        kind: typeof r["kind"] === "string" ? r["kind"] : "",
        ...(typeof r.revision === "string" ? { revision: r.revision } : {}),
      };
    });
  }
}
