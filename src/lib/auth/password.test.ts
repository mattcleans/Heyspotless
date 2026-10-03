import { describe, expect, it } from "vitest";
import {
  continueAfterSignIn,
  loginDestinationCookie,
  passwordAuthError,
  passwordDestination,
  passwordIssue,
} from "./password";

describe("password sign-in and recovery navigation", () => {
  it.each([
    "//evil.test",
    "https://evil.test",
    "/\\evil.test",
    "/auth/callback",
  ])("does not continue to unsafe or looping destination %s", (next) => {
    expect(continueAfterSignIn(next)).toBe("/auth/continue?next=%2F");
    expect(passwordDestination(next)).toBe("/account/password?next=%2F");
  });
  it("preserves a visit through recovery and the fixed callback cookie", () => {
    const destination = passwordDestination(
      "/customer/visits/own?view=details",
    );
    expect(destination).toBe(
      "/account/password?next=%2Fcustomer%2Fvisits%2Fown%3Fview%3Ddetails",
    );
    expect(loginDestinationCookie(destination, true)).toContain(
      "Path=/auth; Max-Age=3600; SameSite=Lax; Secure",
    );
    expect(
      decodeURIComponent(
        loginDestinationCookie(destination, true)
          .split(";")[0]!
          .slice("hs_login_next=".length),
      ),
    ).toBe(destination);
  });
  it("avoids a password-settings return loop", () =>
    expect(passwordDestination("/account/password?next=/admin")).toBe(
      "/account/password?next=%2F",
    ));
  it("does not mark development HTTP cookies secure", () =>
    expect(loginDestinationCookie("/admin", false)).not.toContain("Secure"));
  it("validates confirmation without changing password whitespace", () => {
    expect(passwordIssue("short", "short")).toContain("8 characters");
    expect(passwordIssue("correct horse", "different")).toContain(
      "don’t match",
    );
    expect(passwordIssue(" correct horse ", "correct horse")).toContain(
      "don’t match",
    );
    expect(passwordIssue(" correct horse ", " correct horse ")).toBeNull();
  });
  it("gives an account-neutral incorrect-password error and actionable retries", () => {
    expect(
      passwordAuthError({ code: "invalid_credentials" }, "sign-in"),
    ).toContain("Email or password is incorrect");
    expect(
      passwordAuthError({ code: "over_request_rate_limit" }, "sign-in"),
    ).toContain("Wait a minute");
    expect(passwordAuthError({ code: "weak_password" }, "save")).toContain(
      "stronger password",
    );
    expect(
      passwordAuthError({ code: "reauthentication_needed" }, "save"),
    ).toContain("Sign in again");
  });
});
