import { toCrewReceipt } from "./types";
export function crewResponse(status: number, payload: unknown, id: string) {
  if (status !== 200)
    return {
      error:
        status === 401
          ? "Sign in again. Your action is still here."
          : status === 403
            ? "Use your connected account, or call the office for help."
            : status === 409
              ? "The crew or availability changed. Refresh and review before trying again."
              : "We could not confirm your answer. Check your connection and retry the same action.",
      signIn: status === 401 || status === 403,
    };
  try {
    const receipt = toCrewReceipt(payload);
    if (receipt.id !== id || receipt.state === "review") throw new Error();
    return { receipt };
  } catch {
    return {
      error:
        "We could not confirm the save. Retry the same action or refresh to check its status.",
      signIn: false,
    };
  }
}
