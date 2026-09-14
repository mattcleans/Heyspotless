import { describe, expect, it } from "vitest";
import {
  CLEANER_SHARE_OF_TICKET,
  MINIMUM_PAYOUT_CENTS,
  PayoutError,
  ceilingShareFromW2Cost,
  impliedHourlyCents,
  payoutForTicket,
  shareOfTicket,
} from "./payout";
import { buildQuote } from "./quote";

describe("payoutForTicket", () => {
  it("pays the standard share of whatever the customer pays", () => {
    expect(payoutForTicket(17000)).toBe(6800);
    expect(payoutForTicket(16000)).toBe(6400);
  });

  it("moves the cleaner's fee with a discount to the customer", () => {
    // The rule, stated as a test: same house, same work, our price differs by
    // the recurring discount, and her fee follows it in proportion.
    const weekly = buildQuote("standard", "weekly", { bedrooms: 3, bathrooms: 3 });
    const oneTime = buildQuote("standard", "one_time", { bedrooms: 3, bathrooms: 3 });

    expect(weekly.estimatedMinutes).toBe(oneTime.estimatedMinutes);

    const discount = weekly.totalCents / oneTime.totalCents;
    const payRatio =
      payoutForTicket(weekly.totalCents) / payoutForTicket(oneTime.totalCents);
    expect(payRatio).toBeCloseTo(discount, 4);
  });

  it("rounds to the cent rather than shaving in the platform's favour", () => {
    // 40% of $10.01 is 400.4 cents. Rounding down by convention would take a
    // fraction of a cent off every job in one direction, for ever.
    expect(payoutForTicket(1001)).toBe(400);
    expect(payoutForTicket(1004)).toBe(402);
  });

  it("honours a negotiated share", () => {
    expect(payoutForTicket(17000, 0.45)).toBe(7650);
  });

  it("refuses a share outside 0 to 1", () => {
    expect(() => payoutForTicket(17000, 0)).toThrow(PayoutError);
    expect(() => payoutForTicket(17000, 1.5)).toThrow(PayoutError);
  });

  it("refuses a negative ticket", () => {
    expect(() => payoutForTicket(-1)).toThrow(PayoutError);
  });

  it("is off by default on the floor", () => {
    // The lever for the acquisition problem. Turning it on changes what every
    // discounted clean pays, so it is a decision with a number attached
    // rather than a default.
    expect(MINIMUM_PAYOUT_CENTS).toBeNull();
  });

  it("lifts a discounted job when a floor is set", () => {
    expect(payoutForTicket(16000, CLEANER_SHARE_OF_TICKET, 7000)).toBe(7000);
    // And leaves a job already above it alone.
    expect(payoutForTicket(30000, CLEANER_SHARE_OF_TICKET, 7000)).toBe(12000);
  });

  it("never lets a floor pay more than the customer paid", () => {
    // Not a floor doing its job — a misconfiguration, and it must not reach
    // anybody's screen as a payout larger than the ticket.
    expect(payoutForTicket(5000, CLEANER_SHARE_OF_TICKET, 9000)).toBe(5000);
  });
});

describe("readings, not prices", () => {
  it("reports the implied hourly rate without it being an input", () => {
    // 40% of $194.00 over 173 minutes.
    expect(impliedHourlyCents(7760, 173)).toBe(2691);
  });

  it("returns zero rather than dividing by an absent estimate", () => {
    expect(impliedHourlyCents(7760, 0)).toBe(0);
  });

  it("inverts the share for reporting", () => {
    expect(shareOfTicket(6800, 17000)).toBeCloseTo(0.4, 5);
    expect(shareOfTicket(6800, 0)).toBe(0);
  });
});

describe("the ceiling is a cost, not a percentage", () => {
  it("expresses the cheapest W-2 option as a share of this job", () => {
    expect(ceilingShareFromW2Cost(7271, 17000)).toBeCloseTo(0.4277, 4);
  });

  it("is zero for a job with no price rather than infinite", () => {
    expect(ceilingShareFromW2Cost(7271, 0)).toBe(0);
  });
});
