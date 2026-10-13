import { describe, expect, it } from "vitest";
import { offerAnswerState } from "./offer-answer";
describe("cleaner offer answer recovery", () => {
  it("settles a withdrawn capacity conflict without saying booked or declined", () => {
    const state = offerAnswerState(409, { outcome: "conflict" });
    expect(state).toMatchObject({ status: "settled", tone: "plain" });
    expect(state.message).toContain("withdrawn");
    expect(state.message).toContain("won't count against you");
  });
  it.each([400, 401, 409, 500])(
    "never treats HTTP %s with an accepted payload as booked",
    (status) => {
      expect(
        offerAnswerState(status, { outcome: "accepted", message: "Booked" })
          .status,
      ).toBe("error");
    },
  );
  it("keeps buttons available for a genuine transaction conflict without exposing a database message", () => {
    const state = offerAnswerState(409, {
      retryable: true,
      error: "PRIVATE OTHER CLIENT DETAILS",
    });
    expect(state.status).toBe("error");
    expect(state.message).toContain("Try again");
    expect(state.message).not.toContain("PRIVATE");
  });
  it("shows session recovery even when a stale success payload exists", () => {
    expect(offerAnswerState(401, { outcome: "accepted" })).toMatchObject({
      status: "error",
      signIn: true,
    });
  });
  it("identifies a preview refusal without claiming a live result", () => {
    expect(offerAnswerState(409, { preview: true })).toMatchObject({
      status: "error",
      message: expect.stringContaining("Preview"),
    });
  });
  it.each([
    [200, "accepted", "good"],
    [200, "declined", "plain"],
    [200, "superseded", "plain"],
    [409, "taken", "plain"],
    [410, "expired", "plain"],
    [404, "not_found", "plain"],
  ] as const)("settles known outcome %s/%s", (status, outcome, tone) => {
    expect(offerAnswerState(status, { outcome })).toMatchObject({
      status: "settled",
      tone,
    });
  });
  it.each([
    null,
    [],
    {},
    { outcome: "unknown" },
    { outcome: "constructor" },
    { outcome: "conflict", retryable: "true", error: "PRIVATE" },
  ])("does not invent a saved answer from %j", (payload) => {
    const state = offerAnswerState(500, payload);
    expect(state.status).toBe("error");
    expect(state.message).not.toContain("PRIVATE");
  });
});

it("offers sign-in for a wrong-role account and office help for an unlinked cleaner", () => {
  expect(offerAnswerState(403, { accountRequired: true })).toMatchObject({
    status: "error",
    signIn: true,
  });
  const unlinked = offerAnswerState(403, { linkRequired: true });
  expect(unlinked.message).toContain("connect your cleaner account");
  expect(unlinked).not.toHaveProperty("signIn");
});
