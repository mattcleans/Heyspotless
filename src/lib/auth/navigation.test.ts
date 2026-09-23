import { describe, expect, it } from "vitest";
import { safeNext, destinationFor } from "./navigation";
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
