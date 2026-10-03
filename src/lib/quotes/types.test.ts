import { describe, it, expect } from "vitest";
import { parseQuoteAction, toClientQuote, quoteCadence } from "./types";
const id = "c8400000-0000-0000-0000-000000000001";
export const quoteFixture = {
  id,
  customerId: id,
  propertyId: id,
  service: "standard",
  frequency: "one_time",
  totalCents: 5000,
  estimatedMinutes: 30,
  proposedStart: "2028-01-03T15:00:00Z",
  expiresAt: "2027-12-30T15:00:00Z",
  repeats: false,
  note: "Visible note",
  version: 1,
  accepted: null,
  decisionId: null,
  jobId: null,
  planId: null,
  state: "published",
  home: { street: "Sample Home", city: "Dallas", state: "TX", zip: "75001" },
  lines: [
    {
      itemKey: "arrival",
      name: "Arrival",
      quantity: 1,
      unitPriceCents: 5000,
      totalCents: 5000,
      cleanMinutes: 30,
      isExtra: false,
    },
  ],
};
const prepare = {
  action: "prepare",
  id,
  propertyId: id,
  service: "standard",
  frequency: "weekly",
  start: "2028-01-03T09:00",
  expires: "2028-01-02T09:00",
  repeats: true,
  extras: [{ itemKey: "refrigerator", quantity: 2 }],
  note: " Client note ",
};
describe("owned client quote terms", () => {
  it("parses Dallas local times without the server zone", () => {
    expect(parseQuoteAction(prepare)).toMatchObject({
      start: "2028-01-03T15:00:00.000Z",
      expires: "2028-01-02T15:00:00.000Z",
      note: "Client note",
    });
  });
  it("rejects the missing spring hour", () =>
    expect(() =>
      parseQuoteAction({ ...prepare, start: "2027-03-14T02:30" }),
    ).toThrow());
  it.each(["priceCents", "customerId", "cleanerId", "minutes"])(
    "rejects caller supplied %s",
    (key) => expect(() => parseQuoteAction({ ...prepare, [key]: 1 })).toThrow(),
  );
  it.each([0, 21, 1.5, -1])("rejects invalid extra quantity %s", (quantity) =>
    expect(() =>
      parseQuoteAction({
        ...prepare,
        extras: [{ itemKey: "refrigerator", quantity }],
      }),
    ).toThrow(),
  );
  it("rejects duplicate extras", () =>
    expect(() =>
      parseQuoteAction({
        ...prepare,
        extras: [...prepare.extras, ...prepare.extras],
      }),
    ).toThrow());
  it("requires a reviewed version and decision request identity", () => {
    expect(() =>
      parseQuoteAction({ action: "decide", id, requestId: id, version: 1 }),
    ).toThrow();
    expect(
      parseQuoteAction({
        action: "decide",
        id,
        requestId: id,
        version: 1,
        accept: false,
      }),
    ).toMatchObject({ accept: false, version: 1 });
  });
  it("rejects caller booking time or price", () =>
    expect(() =>
      parseQuoteAction({
        action: "book",
        id,
        version: 2,
        start: prepare.start,
      }),
    ).toThrow());
  it("validates complete response totals and decision state", () => {
    expect(toClientQuote(quoteFixture)).toMatchObject({
      totalCents: 5000,
      state: "published",
    });
    expect(() => toClientQuote({ ...quoteFixture, totalCents: 1 })).toThrow();
    expect(() =>
      toClientQuote({ ...quoteFixture, state: "accepted" }),
    ).toThrow();
    expect(() =>
      toClientQuote({ ...quoteFixture, estimatedMinutes: 10 }),
    ).toThrow();
  });
  it("does not require the historical booked visit to remain available", () =>
    expect(
      toClientQuote({
        ...quoteFixture,
        state: "booked",
        accepted: true,
        decisionId: id,
        jobId: null,
      }),
    ).toMatchObject({ state: "booked", jobId: null }));
  it.each(["2028-01-03T15:00", "infinity", "2028-01-03T99:00:00Z"])(
    "rejects invalid or unzoned receipt date %s",
    (proposedStart) =>
      expect(() => toClientQuote({ ...quoteFixture, proposedStart })).toThrow(),
  );
});

describe("quoted recurrence", () => {
  it("uses the Dallas weekday and clock for fortnightly cleans", () =>
    expect(
      quoteCadence({
        proposedStart: "2028-01-04T02:00:00Z",
        frequency: "biweekly",
        repeats: true,
      }),
    ).toBe("Every other Monday at 8:00 PM, Dallas time."));
  it("explains fifth weekday clamping for monthly cleans", () =>
    expect(
      quoteCadence({
        proposedStart: "2027-01-29T15:00:00Z",
        frequency: "monthly",
        repeats: true,
      }),
    ).toBe(
      "Every month on the fifth Friday (or the last Friday in a shorter month) at 9:00 AM, Dallas time.",
    ));
  it("keeps rate frequency separate from repeating", () =>
    expect(
      quoteCadence({
        proposedStart: "2028-01-03T15:00:00Z",
        frequency: "weekly",
        repeats: false,
      }),
    ).toContain("One visit; no recurring schedule"));
});
