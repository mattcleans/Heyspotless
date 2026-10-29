export const PAYMENT_REVIEW_PAGE_SIZE = 50;

export interface PaymentReviewItem {
  id: string;
  invoiceId: string;
  customerId: string;
  customerName: string;
  jobId: string | null;
  amountCents: number;
  balanceCents: number;
  createdAt: string;
  expiresAt: string;
  channel: "checkout" | "autocharge";
  state: "open" | "abandoned";
  providerReference: string | null;
  requestReference: string;
}

export function paymentReviewReason(item: PaymentReviewItem, now: Date): string {
  if (item.state === "abandoned") return "Older request needs manual review";
  if (!item.providerReference) return "Provider receipt is missing";
  if (new Date(item.expiresAt).getTime() <= now.getTime()) return "Still unresolved after the local deadline";
  return item.channel === "checkout" ? "Payment page is still open or processing" : "Automatic payment is still processing";
}

/** Matches the database guard: a late webhook has time to land first. */
export const PAYMENT_RELEASE_MIN_AGE_MS = 30 * 60 * 1000;

/** Only claims a status check cannot answer are released by a person. */
export function paymentReleasable(item: PaymentReviewItem): boolean {
  return item.state === "abandoned" || !item.providerReference;
}

/** True when the request is old enough for the database to release it. */
export function paymentReleaseReady(item: PaymentReviewItem, now: Date): boolean {
  if (item.state === "abandoned") return true;
  return now.getTime() - new Date(item.createdAt).getTime() >= PAYMENT_RELEASE_MIN_AGE_MS;
}

export function paymentReleaseMessage(result: { released: boolean; reason: string | null }): string {
  if (result.released) return "Request released. The Client can pay again, and an automatic payment will use a new attempt.";
  if (result.reason === "too_recent") return "This request is too recent to release. Wait 30 minutes after it started, then check Stripe again.";
  if (result.reason === "provider_reference") return "This request has a Stripe reference. Use Check payment status instead.";
  if (result.reason === "resolved") return "This request was already resolved. Refresh the list.";
  return "Request not found. Refresh the list.";
}

export function paymentReviewPage(raw: unknown): number {
  if (typeof raw !== "string" || !/^[1-9]\d{0,5}$/.test(raw)) return 1;
  return Number(raw);
}

export function paymentReviewMessage(result: { state: string; reviewRequired?: boolean }): string {
  if (result.reviewRequired) return "The outcome could not be confirmed. Keep this request on hold and review it in Stripe before collecting again.";
  if (result.state === "settled") return "Payment recorded. Review the latest invoice balance before considering another payment.";
  if (result.state === "cleared") return "No open payment request remains. Refresh the list and review the current invoice before arranging another payment.";
  return "The payment request is still active. Keep it on hold while it is open or processing.";
}
