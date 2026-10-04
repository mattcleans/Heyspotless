import { describe, expect, it } from "vitest";
import {
  safeNext,
  destinationFor,
  callbackFailure,
  LOGIN_ERRORS,
} from "./navigation";
describe("sign-in navigation", () => {
  it.each([
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/\nevil.test",
    "/auth/callback",
    "/login?next=/admin",
    "/account-setup",
    null,
  ])("rejects unsafe or looping next %s", (next) =>
    expect(safeNext(next)).toBe("/"),
  );
  it("preserves a local visit and its query", () =>
    expect(safeNext("/customer/visits/abc?view=details")).toBe(
      "/customer/visits/abc?view=details",
    ));
  it.each([
    ["admin", "/admin"],
    ["cleaner", "/cleaner"],
    ["customer", "/customer"],
  ])("lands %s in its workspace", (role, home) =>
    expect(destinationFor(role, "/")).toBe(home),
  );
  it("does not route a customer to management", () =>
    expect(destinationFor("customer", "/admin/customers")).toBe("/customer"));
  it("retains an authorized deep link", () =>
    expect(destinationFor("admin", "/admin/customers/abc")).toBe(
      "/admin/customers/abc",
    ));
  it("makes missing role setup explicit", () =>
    expect(destinationFor("unknown", "/admin")).toBe("/account-setup"));
});

describe("email callback failures", () => {
  it.each(["otp_expired", "flow_state_expired"])(
    "reports expiry only for the known expiry code %s",
    (code) => expect(callbackFailure({ code })).toBe("email_link_expired"),
  );
  it.each(["bad_code_verifier", "pkce_code_verifier_not_found"])(
    "separates browser request mismatches from expiry: %s",
    (code) => expect(callbackFailure({ code })).toBe("browser_context_missing"),
  );
  it.each(["unexpected_failure", "request_timeout"])(
    "offers a service retry for %s",
    (code) => expect(callbackFailure({ code })).toBe("service_unavailable"),
  );
  it("handles provider redirect codes without reflecting raw error details", () => {
    expect(callbackFailure("otp_expired")).toBe("email_link_expired");
    expect(callbackFailure("private-token-value")).toBe("invalid_code");
    expect(callbackFailure({ message: "expired private-token-value" })).toBe(
      "invalid_code",
    );
    expect(callbackFailure(null)).toBe("invalid_code");
  });
  it("does not claim unknown or missing flow state is an expired link", () => {
    const reason = callbackFailure({ code: "flow_state_not_found" });
    expect(reason).toBe("invalid_code");
    expect(LOGIN_ERRORS[reason]).not.toContain("expired");
  });
});
