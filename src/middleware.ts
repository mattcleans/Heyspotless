import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isDemoMode, supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";

/**
 * Session refresh and role gating.
 *
 * Two jobs. First, refresh the auth token on every request — Server Components
 * cannot write cookies, so if middleware does not do it the session expires
 * mid-visit. Second, keep each role inside its own surface.
 *
 * This is a convenience boundary, not the security boundary. Row-level security
 * in Postgres is what actually stops a cleaner reading another cleaner's
 * earnings; middleware just avoids rendering a page they would find empty.
 */

/** Which roles may enter each area. Admin sees everything. */
const AREA_ROLES: { prefix: string; roles: string[] }[] = [
  { prefix: "/admin", roles: ["admin"] },
  { prefix: "/cleaner", roles: ["cleaner", "admin"] },
  { prefix: "/customer", roles: ["customer", "admin"] },
];

const HOME_FOR_ROLE: Record<string, string> = {
  admin: "/admin/dispatch",
  cleaner: "/cleaner",
  customer: "/customer",
};

export async function middleware(request: NextRequest) {
  // Demo mode has no auth at all, so every surface is open. That is what lets
  // the app be reviewed with no credentials.
  if (isDemoMode()) return NextResponse.next();

  const url = supabaseUrl();
  const anonKey = supabaseAnonKey();
  if (!url || !anonKey) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() revalidates against Supabase. getSession() only reads the cookie,
  // which a client can forge — never gate on it.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const area = AREA_ROLES.find((a) => path === a.prefix || path.startsWith(`${a.prefix}/`));
  if (!area) return response;

  if (!user) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const role = typeof profile?.role === "string" ? profile.role : null;

  if (!role || !area.roles.includes(role)) {
    // Send them to their own surface rather than a dead end.
    const home = request.nextUrl.clone();
    home.pathname = role ? (HOME_FOR_ROLE[role] ?? "/") : "/";
    home.search = "";
    return NextResponse.redirect(home);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image optimisation. Auth cookies must
     * be refreshed on real navigations, not on every icon fetch.
     */
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
