/** Interprets a server-confirmed offer answer without inventing acceptance. */
export type OfferAnswerState =
  | { status: "error"; message: string; signIn?: boolean }
  | { status: "settled"; tone: "good" | "plain"; message: string };
const outcomes = {
  accepted: { status: 200, message: "Booked. It's on your schedule." },
  declined: {
    status: 200,
    message: "Thanks — we'll find someone else for this one.",
  },
  taken: {
    status: 409,
    message: "Someone else took this one. It won't count against you.",
  },
  conflict: {
    status: 409,
    message:
      "This offer overlapped another accepted visit, so it was withdrawn. It won't count against you.",
  },
  expired: { status: 410, message: "This offer has expired." },
  superseded: { status: 200, message: "You've already answered this one." },
  not_found: { status: 404, message: "That offer isn't available." },
} as const;
export function offerAnswerState(
  status: number,
  payload: unknown,
): OfferAnswerState {
  if (status === 401)
    return {
      status: "error",
      signIn: true,
      message: "Your session has ended. Sign in again to answer this offer.",
    };
  const data =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  if (status === 409 && data.retryable === true)
    return {
      status: "error",
      message:
        "Your schedule changed while answering. Try again to check the offer’s current result.",
    };
  if (status === 409 && data.preview === true)
    return {
      status: "error",
      signIn: true,
      message:
        "Preview offers cannot be answered. Sign in to accept your own offers.",
    };
  if (status === 403 && data.accountRequired === true)
    return {
      status: "error",
      signIn: true,
      message: "Use your cleaner account to answer this offer.",
    };
  if (status === 403 && data.linkRequired === true)
    return {
      status: "error",
      message:
        "Call the office to connect your cleaner account before answering offers.",
    };
  if (
    typeof data.outcome === "string" &&
    Object.hasOwn(outcomes, data.outcome)
  ) {
    const result = outcomes[data.outcome as keyof typeof outcomes];
    if (status === result.status)
      return {
        status: "settled",
        tone: data.outcome === "accepted" ? "good" : "plain",
        message:
          typeof data.message === "string" &&
          data.message.trim() &&
          data.message.length <= 1000
            ? data.message
            : result.message,
      };
  }
  return {
    status: "error",
    message:
      "We couldn’t confirm your answer. Try again, or call the office for help.",
  };
}
