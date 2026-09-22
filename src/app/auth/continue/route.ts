import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isDemoMode } from "@/lib/supabase/env";
import { destinationFor, safeNext } from "@/lib/auth/navigation";

export async function GET(request: NextRequest) {
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const redirect = (path: string) =>
    NextResponse.redirect(new URL(path, request.nextUrl.origin));
  if (isDemoMode()) return redirect(next);
  try {
    const db = await createClient();
    const {
      data: { user },
      error: authError,
    } = await db.auth.getUser();
    if (authError || !user)
      return redirect(`/login?next=${encodeURIComponent(next)}`);
    const { data: profile, error } = await db
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (error) return redirect("/login?error=service_unavailable");
    if (!profile) return redirect("/account-setup");
    if (profile.role === "customer" || profile.role === "cleaner") {
      const table = profile.role === "customer" ? "customers" : "cleaners";
      const { data: linked, error: linkError } = await db
        .from(table)
        .select("id")
        .eq("profile_id", user.id)
        .maybeSingle();
      if (linkError) return redirect("/login?error=service_unavailable");
      if (!linked) return redirect("/account-setup");
    }
    return redirect(destinationFor(profile.role, next));
  } catch {
    return redirect("/login?error=service_unavailable");
  }
}
