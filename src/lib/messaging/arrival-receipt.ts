export type ArrivalTextState = "not_requested" | "accepted" | "unconfirmed" | "unavailable" | "sign_in";
export interface ArrivalTextReceipt { state: ArrivalTextState; message: string }

export function arrivalTextReceipt(row: { providerId: string | null; failedReason: string | null } | null): ArrivalTextReceipt {
  if (!row) return { state: "not_requested", message: "" };
  // delivered_at on older messages records API acceptance, not carrier delivery.
  if (row.providerId?.trim() && !row.failedReason) return {
    state: "accepted", message: "Your arrival text was submitted. Delivery to the Client has not been confirmed.",
  };
  return unconfirmedArrivalText();
}

export function unconfirmedArrivalText(): ArrivalTextReceipt {
  return { state: "unconfirmed", message: "The arrival text status could not be confirmed. Ask the office to check before sending another text." };
}
