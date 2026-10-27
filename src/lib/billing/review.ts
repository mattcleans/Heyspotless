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
