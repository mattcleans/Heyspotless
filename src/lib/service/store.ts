import "server-only";

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
export class ServiceStore {
  constructor(private readonly db: SupabaseClient) {}

  /** She has arrived. Idempotent — a second tap does not move the arrival. */
  async start(jobId: string, cleanerId: string): Promise<boolean> {
    const { data, error } = await this.db.rpc("start_job", {
      p_job_id: jobId,
      p_cleaner_id: cleanerId,
    });
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
  async recordPhoto(input: {
    jobId: string;
    cleanerId: string;
    storagePath: string;
    kind: "before" | "after" | "issue";
    roomKey: string;
  }): Promise<string | null> {
    const { data, error } = await this.db.rpc("record_job_photo", {
      p_job_id: input.jobId,
      p_cleaner_id: input.cleanerId,
      p_storage_path: input.storagePath,
      p_kind: input.kind,
      p_room_key: input.roomKey,
    });
    if (error) throw new Error(`recordPhoto: ${error.message}`);
    return typeof data === "string" ? data : null;
  }

  /** The photos already in for a job, for working out what is outstanding. */
  async photosFor(jobId: string): Promise<{ roomKey: string | null; kind: string }[]> {
    const { data, error } = await this.db
      .from("job_photos")
      .select("room_key, kind")
      .eq("job_id", jobId);
    if (error) throw new Error(`photosFor: ${error.message}`);

    return (Array.isArray(data) ? data : []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        roomKey: typeof r["room_key"] === "string" ? r["room_key"] : null,
        kind: typeof r["kind"] === "string" ? r["kind"] : "",
      };
    });
  }
}
