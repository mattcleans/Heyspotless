import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

/**
 * Ends the session and lands on the sign-in page.
 *
 * POST only, so a prefetched or crawled link can never sign someone out. The
 * 303 turns the form submission into a plain GET of /login.
 */
export async function POST(request: NextRequest) {
  const login = new URL("/login", request.nextUrl.origin);
  if (!isDemoMode()) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.signOut();
      if (error) login.searchParams.set("error", "sign_out_failed");
    } catch {
      login.searchParams.set("error", "sign_out_failed");
    }
  }
  return NextResponse.redirect(login, { status: 303 });
}
