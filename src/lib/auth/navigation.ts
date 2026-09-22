export const ROLE_HOME: Record<string, string> = {
  admin: "/admin",
  cleaner: "/cleaner",
  customer: "/customer",
};

/** Reject URL parser edge cases as well as protocol-relative redirects. */
export function safeNext(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    /[\\\u0000-\u0020]/.test(raw)
  )
    return "/";
  try {
    const url = new URL(raw, "https://local.invalid");
    if (url.origin !== "https://local.invalid") return "/";
    if (
      ["/login", "/auth", "/account-setup"].some(
        (path) => url.pathname === path || url.pathname.startsWith(`${path}/`),
      )
    )
      return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function destinationFor(role: string, raw: unknown): string {
  const home = ROLE_HOME[role];
  if (!home) return "/account-setup";
  const next = safeNext(raw);
  if (next === "/") return home;
  const path = new URL(next, "https://local.invalid").pathname;
  const area = ["admin", "cleaner", "customer"].find(
    (r) => path === `/${r}` || path.startsWith(`/${r}/`),
  );
  return !area || role === "admin" || area === role ? next : home;
}

export const LOGIN_ERRORS: Record<string, string> = {
  missing_code: "This sign-in link is incomplete. Request a new link below.",
  invalid_code:
    "This link has expired, was already used, or opened in a different browser. Request a new link and open it in this browser on this device.",
  service_unavailable:
    "Sign-in is temporarily unavailable. Try again shortly or call 469-280-0397.",
};

export function savedNext(value: string | undefined): string {
  try {
    return safeNext(value ? decodeURIComponent(value) : "/");
  } catch {
    return "/";
  }
}
