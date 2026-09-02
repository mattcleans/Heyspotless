import "server-only";

import { isDemoMode } from "../supabase/env";
import { createClient } from "../supabase/server";
import { createAdminClient } from "../supabase/admin";
import { DemoRepository } from "./demo-repository";
import { SupabaseRepository } from "./supabase-repository";
import type { Repository } from "./repository";

/**
 * The repository for the current request.
 *
 * Demo mode (no Supabase configured, or DEMO_MODE=1) serves fixtures, so the
 * whole app runs with no credentials. Otherwise it is Supabase acting as the
 * signed-in user, with row-level security applying.
 */
export async function getRepository(): Promise<Repository> {
  if (isDemoMode()) return new DemoRepository();
  return new SupabaseRepository(await createClient());
}

/**
 * Repository with row-level security BYPASSED. Only for contexts with no user:
 * webhooks and scheduled cron work. Never for a page render.
 */
export function getAdminRepository(): Repository {
  if (isDemoMode()) return new DemoRepository();
  return new SupabaseRepository(createAdminClient());
}

export type { Repository };
export * from "./types";
