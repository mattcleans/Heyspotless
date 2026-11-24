import { describe, expect, it } from "vitest";
import { connectionRefusal, CONNECTION_REFUSALS, readSignInStatus } from "./sign-in-connection";

const profile = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("reading the database's sign-in status", () => {
  it("reads a customer with candidates", () => {
    expect(
      readSignInStatus({
        found: true,
        customerEmail: "kim@example.test",
        connected: null,
        candidates: [{ profileId: profile, email: "kim@example.test", confirmedAt: "2026-11-23T10:00:00Z", signedUpAt: "2026-11-23T09:00:00Z" }],
        customersWithThisEmail: 2,
      }),
    ).toEqual({
      customerEmail: "kim@example.test",
      connected: null,
      candidates: [{ profileId: profile, email: "kim@example.test", confirmedAt: "2026-11-23T10:00:00Z", signedUpAt: "2026-11-23T09:00:00Z" }],
      customersWithThisEmail: 2,
    });
  });

  it("reads a connected customer", () => {
    const status = readSignInStatus({
      found: true,
      customerEmail: "kim@example.test",
      connected: { profileId: profile, email: "kim@example.test", connectedAt: null },
      candidates: [],
      customersWithThisEmail: 1,
    });
    expect(status?.connected).toEqual({ profileId: profile, email: "kim@example.test", connectedAt: null });
  });

  it.each([
    ["nothing", null],
    ["an unknown customer", { found: false }],
    ["candidates that are not a list", { found: true, candidates: "x" }],
    ["a candidate with a bad id", { found: true, candidates: [{ profileId: "nope", email: "a@b.c" }] }],
    ["a candidate with no email", { found: true, candidates: [{ profileId: profile }] }],
    ["a connection with a bad id", { found: true, connected: { profileId: 7 }, candidates: [] }],
  ])("refuses %s", (_label, value) => {
    expect(readSignInStatus(value)).toBeNull();
  });

  it("treats a nonsense shared count as zero", () => {
    expect(readSignInStatus({ found: true, candidates: [], customersWithThisEmail: -3 })?.customersWithThisEmail).toBe(0);
  });
});

describe("explaining a refusal", () => {
  it("has a message for every reason the database gives", () => {
    for (const reason of ["no_sign_in", "not_a_customer_sign_in", "no_customer", "customer_has_sign_in", "sign_in_in_use", "email_not_confirmed", "email_mismatch"]) {
      expect(CONNECTION_REFUSALS[reason]).toBeTruthy();
      expect(connectionRefusal(reason)).toBe(CONNECTION_REFUSALS[reason]);
    }
  });

  it("falls back for anything else", () => {
    expect(connectionRefusal("unheard_of")).toMatch(/could not be made/);
    expect(connectionRefusal(undefined)).toMatch(/could not be made/);
  });
});
