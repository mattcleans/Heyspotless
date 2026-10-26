import { fetchWithTimeout } from "@/lib/http/fetch-with-timeout";
import { isReviewId } from "./visit-review";

export type DraftResult =
  | { confirmed: true; invoiceId: string; status: string; totalCents: number; message: string }
  | { confirmed: false; message: string; signIn: boolean };
const unconfirmed = "The draft status could not be confirmed. Refresh this visit before trying again.";

/** Never retries a write or treats an unreadable response as a saved draft. */
export async function requestServiceDraft(visitId: string, reviewedPriceCents: number): Promise<DraftResult> {
  try {
    const response = await fetchWithTimeout(`/api/admin/visits/${visitId}/invoice-draft`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewedPriceCents }),
    });
    const data: unknown = await response.json();
    const row = data && typeof data === "object" ? data as Record<string, unknown> : {};
    if (!response.ok) return { confirmed: false, signIn: response.status === 401, message:
      response.status === 401 ? "Sign in to Management, then reopen this visit to check its invoice record." :
      response.status === 409 ? "The draft was not confirmed. Refresh this visit and review its current price, saved photos and invoice records." : unconfirmed };
    if (row.confirmed !== true || row.visitId !== visitId || typeof row.invoiceId !== "string" || !isReviewId(row.invoiceId) || !["draft", "sent", "paid", "overdue"].includes(String(row.status)) || typeof row.totalCents !== "number" || !Number.isSafeInteger(row.totalCents) || row.totalCents < 0) throw new Error("Unconfirmed draft");
    return { confirmed: true, invoiceId: row.invoiceId, status: String(row.status), totalCents: row.totalCents,
      message: row.status === "draft" ? "Service draft ready. No payment was taken." : "Existing service invoice confirmed. No new payment was taken." };
  } catch { return { confirmed: false, signIn: false, message: unconfirmed }; }
}
