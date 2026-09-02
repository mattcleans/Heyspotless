/**
 * Environment access for Supabase.
 *
 * Reading these through functions rather than inline `process.env` gives one
 * place to fail loudly with a useful message, and keeps the service-role key
 * from being referenced anywhere a bundler might follow it into client code.
 */

export function supabaseUrl(): string | null {
  return process.env.NEXT_PUBLIC_SUPABASE_URL || null;
}

export function supabaseAnonKey(): string | null {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null;
}

/**
 * True when the app has a real Supabase project to talk to. When false the
 * repository serves fixtures, so the whole UI still runs with no credentials.
 */
export function hasSupabaseConfig(): boolean {
  return Boolean(supabaseUrl() && supabaseAnonKey());
}

/**
 * Demo mode is the default until a Supabase project is configured. Setting
 * DEMO_MODE=1 forces fixtures even when credentials exist, which is useful for
 * screenshots and for demoing without touching production data.
 */
export function isDemoMode(): boolean {
  if (process.env.DEMO_MODE === "1") return true;
  if (process.env.DEMO_MODE === "0") return false;
  return !hasSupabaseConfig();
}

export function requireSupabaseConfig(): { url: string; anonKey: string } {
  const url = supabaseUrl();
  const anonKey = supabaseAnonKey();
  if (!url || !anonKey) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY, or run in demo mode (DEMO_MODE=1). " +
        "See docs/setup.md.",
    );
  }
  return { url, anonKey };
}
