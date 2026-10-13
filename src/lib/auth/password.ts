import { safeNext } from "./navigation";

export function continueAfterSignIn(next: string): string {
  return `/auth/continue?next=${encodeURIComponent(safeNext(next))}`;
}

export function passwordDestination(next: string): string {
  const destination = safeNext(next);
  const path = new URL(destination, "https://local.invalid").pathname;
  return `/account/password?next=${encodeURIComponent(path === "/account/password" ? "/" : destination)}`;
}

export function loginDestinationCookie(next: string, secure: boolean): string {
  return `hs_login_next=${encodeURIComponent(safeNext(next))}; Path=/auth; Max-Age=3600; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function passwordIssue(
  password: string,
  confirmation: string,
): string | null {
  if (password.length < 8)
    return "Use at least 8 characters for your password.";
  if (password !== confirmation)
    return "The passwords don’t match. Enter the same password twice.";
  return null;
}

type PasswordAuth = {
  getUser(): Promise<{
    data: { user: { id: string } | null };
    error: { code?: string } | null;
  }>;
  updateUser(attributes: {
    password: string;
  }): Promise<{ error: { code?: string } | null }>;
};

/** Validate the live account before changing its password, without admin credentials. */
export async function saveOwnPassword(
  auth: PasswordAuth,
  ownerId: string,
  password: string,
  confirmation: string,
): Promise<string | null> {
  const issue = passwordIssue(password, confirmation);
  if (issue) return issue;
  const session = await auth.getUser();
  if (session.error || !session.data.user)
    return "Sign in again or request a new password reset email, then retry.";
  if (session.data.user.id !== ownerId)
    return "The signed-in account changed. Refresh this page before setting a password.";
  const result = await auth.updateUser({ password });
  return result.error ? passwordAuthError(result.error, "save") : null;
}

export function passwordAuthError(
  error: { code?: string } | null,
  action: "sign-in" | "save" | "email",
): string {
  if (error?.code === "over_email_send_rate_limit")
    return "Password and sign-in emails are temporarily limited. Please try again later, or call 469-280-0397 for help.";
  if (error?.code === "over_request_rate_limit")
    return "Too many attempts. Wait a minute, then try again.";
  if (action === "sign-in") {
    if (error?.code === "invalid_credentials")
      return "Email or password is incorrect. Try again, or choose Set or reset password.";
    if (error?.code === "email_not_confirmed")
      return "Confirm your email before signing in. Check your inbox or call the office for help.";
    return "Sign-in is temporarily unavailable. Try again shortly.";
  }
  if (action === "save") {
    if (error?.code === "weak_password")
      return "Choose a stronger password, with a mix of letters, numbers and symbols.";
    if (error?.code === "same_password")
      return "Choose a password different from your current password.";
    if (
      [
        "session_not_found",
        "refresh_token_not_found",
        "reauthentication_needed",
      ].includes(error?.code ?? "")
    )
      return "Sign in again or request a new password reset email, then retry.";
    return "We couldn’t save your password. Try again, or request a new password reset email.";
  }
  return "We couldn’t send the email. Try again shortly, or call 469-280-0397 for help.";
}
