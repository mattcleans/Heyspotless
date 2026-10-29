/**
 * Did Stripe refuse a request before creating anything?
 *
 * Only these answers prove no Checkout session or payment intent exists, so
 * only these may release a collection claim without a person. A timeout, a
 * dropped connection or a 5xx can follow a successful create. An idempotency
 * conflict means an earlier request with the same key already ran. Neither
 * proves anything, and both stay on hold for reconciliation or review.
 */
const REFUSAL_TYPES = new Set([
  "StripeInvalidRequestError",
  "StripeAuthenticationError",
  "StripePermissionError",
  "StripeRateLimitError",
]);
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 429]);

export function isDefiniteStripeRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { type, statusCode } = error as { type?: unknown; statusCode?: unknown };
  return typeof type === "string" && REFUSAL_TYPES.has(type) &&
    typeof statusCode === "number" && REFUSAL_STATUSES.has(statusCode);
}
