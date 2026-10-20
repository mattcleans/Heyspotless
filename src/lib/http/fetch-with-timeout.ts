/** Bound network waits without discarding a durable photo or retrying a write. */
export const CLIENT_REQUEST_TIMEOUT_MS = 120_000;

export function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const parent = init?.signal ?? (input instanceof Request ? input.signal : null);
  const cancel = () => controller.abort(parent?.reason);
  // Keep the deadline through response-body reads, not just response headers.
  // SDKs parse JSON after fetch resolves; a stalled body must also be canceled.
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The request timed out. Try again.", "TimeoutError"));
  }, CLIENT_REQUEST_TIMEOUT_MS);
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  }, { once: true });
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  return fetch(input, { ...init, signal: controller.signal });
}
