import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNext, savedNext } from "@/lib/auth/navigation";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNext(
    searchParams.get("next") ??
      savedNext(request.cookies.get("hs_login_next")?.value),
  );
  const fail = (error: string) => {
    const url = new URL("/login", origin);
    url.searchParams.set("error", error);
    url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  };
  if (searchParams.has("error")) return fail("invalid_code");
  const code = searchParams.get("code");
  if (!code) return fail("missing_code");
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return fail("invalid_code");
  } catch {
    return fail("service_unavailable");
  }
  const url = new URL("/auth/continue", origin);
  url.searchParams.set("next", next);
  const response = NextResponse.redirect(url);
  response.cookies.set("hs_login_next", "", { path: "/auth", maxAge: 0 });
  return response;
}
