"use client";

import { createBrowserClient } from "@supabase/ssr";
import { requireSupabaseConfig } from "./env";
import { fetchWithTimeout } from "../http/fetch-with-timeout";

/**
 * Browser client. Carries the anon key only, so every query it makes is subject
 * to row-level security — which is the point: a cleaner querying from the
 * browser physically cannot read another cleaner's earnings.
 */
export function createClient() {
  const { url, anonKey } = requireSupabaseConfig();
  return createBrowserClient(url, anonKey, {
    global: { fetch: fetchWithTimeout },
  });
}
