import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseConfig } from "./env";

/**
 * Service-role client. BYPASSES ROW-LEVEL SECURITY ENTIRELY.
 *
 * The `server-only` import above makes importing this from a client component a
 * build error rather than a silent key leak. Use it only where the request has
 * no user to act as and the operation is genuinely trusted:
 *
 *   - Stripe and Twilio webhooks, which arrive with no session
 *   - scheduled cron work (reminders, auto-charge, recurring job generation)
 *   - migration and back-office scripts
 *
 * Anything acting on behalf of a signed-in person must use server.ts instead,
 * so RLS still decides what they can see.
 */
export function createAdminClient() {
  const { url } = requireSupabaseConfig();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. It is required for webhooks and " +
        "cron work, and must never be exposed to the browser.",
    );
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
