import { fetchWithTimeout } from "@/lib/http/fetch-with-timeout";

export type PaymentRecovery = "account" | "office" | "sign_in";

export class PaymentSessionError extends Error {
  constructor(message: string, readonly recovery: PaymentRecovery) {
    super(message);
    this.name = "PaymentSessionError";
  }
}

export function uncertainPayment(): PaymentSessionError {
  return new PaymentSessionError(
    "We couldn’t confirm your request. Refresh Account to check the latest payment status before trying again.",
    "account",
  );
}

/** A timeout or unreadable response is not proof that the request failed. */
export async function startSession(path: string, body: unknown): Promise<string> {
  let response: Response;
  let payload: unknown;
  try {
    response = await fetchWithTimeout(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    payload = await response.json();
  } catch {
    throw uncertainPayment();
  }
  const data = payload && typeof payload === "object"
    ? payload as { url?: unknown; status?: unknown; message?: unknown; error?: unknown }
    : {};

  if (!response.ok) {
    if (response.status === 401) {
      throw new PaymentSessionError("Sign in again to review your account before paying.", "sign_in");
    }
    const recovery = data.status === "payment_review_required" || response.status >= 500
      ? "office" : "account";
    const message = typeof data.message === "string" ? data.message
      : typeof data.error === "string" && response.status < 500 ? data.error
      : "Online payment is unavailable. Call the office for help.";
    throw new PaymentSessionError(message, recovery);
  }
  if (typeof data.url !== "string" || !data.url.trim()) throw uncertainPayment();
  return data.url;
}
