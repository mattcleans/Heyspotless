import { describe, expect, it } from "vitest";
import { bookingReviewMatches, parseBookingAction, toBookingReview } from "./types";
import { bookingFixture } from "./test-fixtures";
const id = "c9100000-0000-0000-0000-000000000001";
const input = { action: "review", id, propertyId: id, service: "standard", frequency: "one_time", start: "2028-01-07T11:00", repeats: false, extras: [{ itemKey: "oven", quantity: 1 }], note: "Saved choices" };
describe("owned Client booking contract", () => {
  it("requires the one-time rate for a single visit and resolves Dallas time", () => {
    const r = parseBookingAction(input);
    expect(r).toMatchObject({ action: "review", repeats: false, start: "2028-01-07T17:00:00.000Z", frequency: "one_time" });
  });
  it.each(["totalCents", "customerId", "rooms", "payoutCents", "cleanerId", "actor"]) ("refuses caller-controlled %s", field => {
    expect(() => parseBookingAction({ ...input, [field]: 1 })).toThrow();
    expect(() => parseBookingAction({ action: "confirm", id, [field]: 1 })).toThrow();
  });
  it.each([
    { service: "deep", frequency: "weekly" }, { frequency: "one_time", repeats: true }, { frequency: "weekly", repeats: false },
    { start: "2028-03-12T02:30" }, { propertyId: "other" }, { repeats: "yes" },
    { extras: [{ itemKey: "oven", quantity: 0 }] }, { extras: [{ itemKey: "oven", quantity: 1.5 }] },
    { extras: [{ itemKey: "oven", quantity: 21 }] }, { extras: [{ itemKey: "oven", quantity: 1 }, { itemKey: "oven", quantity: 1 }] },
  ])("refuses malformed or unavailable terms %j", patch => expect(() => parseBookingAction({ ...input, ...patch })).toThrow());
  it("requires a saved visit identity before showing request success", () => {
    expect(() => toBookingReview({ ...bookingFixture, state: "requested" })).toThrow();
    expect(toBookingReview({ ...bookingFixture, state: "requested", jobId: id })).toMatchObject({ state: "requested", jobId: id });
    expect(() => toBookingReview({ ...bookingFixture, jobId: id })).toThrow();
  });
  it("refuses a review for different service, time, notes or extras even with the same ID", () => {
    const action = parseBookingAction({ ...input, extras: [] });
    const review = toBookingReview(bookingFixture);
    expect(bookingReviewMatches(action, review)).toBe(true);
    for (const patch of [{ service: "deep" }, { requestedStart: "2028-01-08T17:00:00Z" }, { note: "Different" }, { repeats: true }])
      expect(bookingReviewMatches(action, { ...review, ...patch } as typeof review)).toBe(false);
    expect(bookingReviewMatches(parseBookingAction(input), review)).toBe(false);
  });
  it("preserves canceled and missing-visit receipts without converting them back to a new request", () => {
    expect(toBookingReview({ ...bookingFixture, state: "canceled", jobId: id }).state).toBe("canceled");
    expect(toBookingReview({ ...bookingFixture, state: "unavailable" }).jobId).toBeNull();
  });
  it.each([{ totalCents: 1 }, { estimatedMinutes: 1 }, { planId: id }, { state: "booked" }, { expiresAt: "bad" }])(
    "refuses inconsistent recorded outcomes %j", patch => expect(() => toBookingReview({ ...bookingFixture, ...patch })).toThrow(),
  );
});
