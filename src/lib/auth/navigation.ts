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
  missing_code:
    "This email link is incomplete. Sign in with your password, or request a new email link.",
  invalid_code:
    "We couldn’t finish signing in from this email link. Sign in with your password, or request a new link and open the newest email in this browser on this device.",
  email_link_expired:
    "This email link has expired. Request a new link and open the newest email in this browser on this device.",
  browser_context_missing:
    "We couldn’t match this email link to its sign-in request. Request a new link in this browser, then open the newest email here on this device.",
  service_unavailable:
    "Sign-in is temporarily unavailable. Try again shortly or call 469-280-0397.",
  sign_out_failed:
    "We couldn’t sign you out. Please try again, or call 469-280-0397.",
};

/** Only known provider codes become public reasons; never expose raw errors. */
export function callbackFailure(error: unknown): string {
  const code =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "code" in error
        ? error.code
        : null;
  if (code === "otp_expired" || code === "flow_state_expired")
    return "email_link_expired";
  if (code === "bad_code_verifier" || code === "pkce_code_verifier_not_found")
    return "browser_context_missing";
  if (code === "unexpected_failure" || code === "request_timeout")
    return "service_unavailable";
  return "invalid_code";
}

export function savedNext(value: string | undefined): string {
  try {
    return safeNext(value ? decodeURIComponent(value) : "/");
  } catch {
    return "/";
  }
}
