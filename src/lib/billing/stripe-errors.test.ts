import { describe, expect, it } from "vitest";
import { isDefiniteStripeRefusal } from "./stripe-errors";

describe("definite Stripe refusals", () => {
  it.each([
    ["StripeInvalidRequestError", 400],
    ["StripeInvalidRequestError", 404],
    ["StripeAuthenticationError", 401],
    ["StripePermissionError", 403],
    ["StripeRateLimitError", 429],
  ])("treats %s (%i) as proof that nothing was created", (type, statusCode) => {
    expect(isDefiniteStripeRefusal({ type, statusCode })).toBe(true);
  });

  it.each([
    ["a lost response", new Error("network response lost")],
    ["a connection error", { type: "StripeConnectionError" }],
    ["a provider 5xx", { type: "StripeAPIError", statusCode: 500 }],
    ["an idempotency conflict", { type: "StripeIdempotencyError", statusCode: 400 }],
    ["a lock conflict", { type: "StripeInvalidRequestError", statusCode: 409 }],
    ["an invalid request without a status", { type: "StripeInvalidRequestError" }],
    ["a missing session URL", { type: "BillingError", statusCode: 400 }],
    ["nothing", null],
  ])("keeps %s on hold", (_, error) => {
    expect(isDefiniteStripeRefusal(error)).toBe(false);
  });
});
