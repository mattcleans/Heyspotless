import { fetchWithTimeout } from "@/lib/http/fetch-with-timeout";
import { unconfirmedArrivalText, type ArrivalTextReceipt, type ArrivalTextState } from "@/lib/messaging/arrival-receipt";
const states: ArrivalTextState[] = ["not_requested", "accepted", "unconfirmed", "unavailable", "sign_in"];

/** Read recovery never repeats a send, including after a lost POST response. */
export async function requestArrivalText(jobId: string, method: "GET" | "POST", signal?: AbortSignal): Promise<ArrivalTextReceipt> {
  try {
    const response = await fetchWithTimeout(method === "GET" ? `/api/jobs/on-my-way?jobId=${encodeURIComponent(jobId)}` : "/api/jobs/on-my-way", {
      method, cache: "no-store", signal,
      ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId }) } : {}),
    });
    const payload: unknown = await response.json();
    if (response.status === 401) return { state: "sign_in", message: "Sign in again to check your arrival text." };
    const data = payload && typeof payload === "object" ? payload as { state?: unknown; message?: unknown } : {};
    if (states.includes(data.state as ArrivalTextState) && typeof data.message === "string") {
      if (!response.ok && (data.state === "accepted" || data.state === "not_requested")) return unconfirmedArrivalText();
      return { state: data.state as ArrivalTextState, message: data.message };
    }
    return unconfirmedArrivalText();
  } catch { return unconfirmedArrivalText(); }
}
