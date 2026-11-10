import { NextResponse, type NextRequest } from "next/server";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { destinationFor, safeNext } from "@/lib/auth/navigation";

export async function GET(request: NextRequest) {
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const redirect = (path: string) =>
    NextResponse.redirect(new URL(path, request.nextUrl.origin));
  if (isDemoMode()) return redirect(next);

  const login = `/login?next=${encodeURIComponent(next)}`;
  const unavailable = `${login}&error=service_unavailable`;
  const deadline = AbortSignal.timeout(12_000);
  try {
    const db = await createClient({
      fetch(input, init) {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
        return fetch(input, {
          ...init,
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        });
      },
    });
    const {
      data: { user },
      error: authError,
    } = await db.auth.getUser();
    if (deadline.aborted || isAuthRetryableFetchError(authError) ||
        authError?.status === 429 || (authError?.status ?? 0) >= 500) {
      return redirect(unavailable);
    }
    if (authError || !user) return redirect(login);
    // A password reset needs only the signed-in account, so it must not be
    // diverted to home or account setup before the person chooses a password.
    if (new URL(next, request.nextUrl.origin).pathname === "/account/password")
      return redirect(next);
    const { data: profile, error } = await db
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (error) return redirect(unavailable);
    if (!profile) return redirect("/account-setup");
    if (profile.role === "customer" || profile.role === "cleaner") {
      const table = profile.role === "customer" ? "customers" : "cleaners";
      const { data: linked, error: linkError } = await db
        .from(table)
        .select("id")
        .eq("profile_id", user.id)
        .maybeSingle();
      if (linkError) return redirect(unavailable);
      if (!linked) return redirect(profile.role === "customer" ? "/customer/account/homes/new" : "/account-setup");
    }
    return redirect(destinationFor(profile.role, next));
  } catch {
    return redirect(unavailable);
  }
}
