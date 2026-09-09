import "server-only";

import { isDemoMode } from "../supabase/env";
import { createClient } from "../supabase/server";
import { createAdminClient } from "../supabase/admin";
import { DemoRepository } from "./demo-repository";
import { SupabaseRepository } from "./supabase-repository";
import { DemoOpsStore, SupabaseOpsStore, type OpsStore } from "./ops-store";
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

/**
 * The write counterpart to getRepository().
 *
 * Note what this does NOT do: it never reaches for the admin client. These
 * writes always happen because a signed-in admin asked for them, so row-level
 * security is the enforcement and the request-scoped client is what applies it.
 * Service-role is reserved for the contexts that genuinely have no user —
 * the Stripe webhook and the cron sweep, which use BillingStore.
 */
export async function getOpsStore(): Promise<OpsStore> {
  if (isDemoMode()) return new DemoOpsStore();
  return new SupabaseOpsStore(await createClient());
}

export type { Repository, OpsStore };
export * from "./types";
