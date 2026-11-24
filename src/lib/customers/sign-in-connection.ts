/**
 * Connecting a customer's confirmed sign-in to their existing record.
 *
 * The database decides; this module only reads its answers defensively and
 * says them in the office's words. See the 20261123180000 migration for the
 * rules: a customer's sign-in, email confirmed and equal to the record's, the
 * record without a sign-in, and the sign-in not already anyone's.
 */

export interface SignInCandidate {
  profileId: string;
  email: string;
  confirmedAt: string | null;
  signedUpAt: string | null;
}

export interface SignInStatus {
  customerEmail: string | null;
  connected: { profileId: string; email: string | null; connectedAt: string | null } | null;
  candidates: SignInCandidate[];
  /** How many customer records carry this customer's email. Above one, say so. */
  customersWithThisEmail: number;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The status function's answer, or null when it is not one this app understands. */
export function readSignInStatus(value: unknown): SignInStatus | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v["found"] !== true) return null;

  let connected: SignInStatus["connected"] = null;
  const c = v["connected"];
  if (c && typeof c === "object") {
    const row = c as Record<string, unknown>;
    if (!isUuid(row["profileId"])) return null;
    connected = { profileId: row["profileId"], email: str(row["email"]), connectedAt: str(row["connectedAt"]) };
  }

  if (!Array.isArray(v["candidates"])) return null;
  const candidates: SignInCandidate[] = [];
  for (const item of v["candidates"]) {
    const row = (item ?? {}) as Record<string, unknown>;
    const email = str(row["email"]);
    if (!isUuid(row["profileId"]) || !email) return null;
    candidates.push({ profileId: row["profileId"], email, confirmedAt: str(row["confirmedAt"]), signedUpAt: str(row["signedUpAt"]) });
  }

  const shared = Number(v["customersWithThisEmail"]);
  return {
    customerEmail: str(v["customerEmail"]),
    connected,
    candidates,
    customersWithThisEmail: Number.isInteger(shared) && shared >= 0 ? shared : 0,
  };
}

/** Why the database refused, in words the office can act on. */
export const CONNECTION_REFUSALS: Record<string, string> = {
  no_sign_in: "That sign-in no longer exists. Refresh the page.",
  not_a_customer_sign_in: "That sign-in belongs to staff, not a customer.",
  no_customer: "This customer record no longer exists. Refresh the page.",
  customer_has_sign_in: "This customer is already connected to a sign-in. Refresh the page.",
  sign_in_in_use: "That sign-in is already connected to another customer.",
  email_not_confirmed: "That sign-in hasn't confirmed its email yet. Ask the customer to open the confirmation email first.",
  email_mismatch:
    "The sign-in's email doesn't match this customer's email. If they signed up with a different address, update their contact details first.",
};

export function connectionRefusal(reason: unknown): string {
  return (typeof reason === "string" && CONNECTION_REFUSALS[reason]) || "The connection could not be made. Refresh the page and try again.";
}
