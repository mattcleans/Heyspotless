import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/** Where a cleaner's devices live. Service-role, like the rest of the sweep. */
export class PushStore {
  constructor(private readonly db: SupabaseClient) {}

  async save(input: {
    profileId: string;
    endpoint: string;
    p256dh: string | null;
    auth: string | null;
    userAgent: string | null;
  }): Promise<string | null> {
    const { data, error } = await this.db.rpc("save_push_subscription", {
      p_profile_id: input.profileId,
      p_endpoint: input.endpoint,
      p_p256dh: input.p256dh,
      p_auth: input.auth,
      p_user_agent: input.userAgent,
    });
    if (error) throw new Error(`save_push_subscription: ${error.message}`);
    return typeof data === "string" ? data : null;
  }

  async remove(endpoint: string): Promise<void> {
    const { error } = await this.db.rpc("delete_push_subscription", { p_endpoint: endpoint });
    if (error) throw new Error(`delete_push_subscription: ${error.message}`);
  }

  async settle(endpoint: string, ok: boolean): Promise<void> {
    const { error } = await this.db.rpc("settle_push", { p_endpoint: endpoint, p_ok: ok });
    if (error) throw new Error(`settle_push: ${error.message}`);
  }

  /** Endpoints to wake, by cleaner. One cleaner can have several devices. */
  async targetsFor(cleanerIds: readonly string[]): Promise<Map<string, string[]>> {
    const byCleaner = new Map<string, string[]>();
    if (cleanerIds.length === 0) return byCleaner;

    const { data, error } = await this.db.rpc("push_targets", { p_cleaner_ids: [...cleanerIds] });
    if (error) throw new Error(`push_targets: ${error.message}`);

    for (const row of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
      const cleanerId = row["cleaner_id"];
      const endpoint = row["endpoint"];
      if (typeof cleanerId !== "string" || typeof endpoint !== "string") continue;

      const endpoints = byCleaner.get(cleanerId) ?? [];
      endpoints.push(endpoint);
      byCleaner.set(cleanerId, endpoints);
    }
    return byCleaner;
  }
}
