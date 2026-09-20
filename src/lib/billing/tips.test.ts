import { describe, expect, it } from "vitest";
import { CARD_PERCENTAGE_FEE, tipDisclosure, tipPassThrough } from "./tips";
import { BillingError } from "./types";

/**
 * A tip is somebody else's money passing through the business. Every case here
 * is one where getting it wrong means quietly keeping part of it.
 */

describe("tipPassThrough", () => {
  it("passes a tip on, less the card percentage", () => {
    // $20.00 → 2.9% is 58¢.
    expect(tipPassThrough(2000)).toEqual({ tipCents: 2000, feeCents: 58, netCents: 1942 });
  });

  /**
   * The rule the business stated: the ONLY permitted deduction is the fee on
   * the tip. Not the 33% the work is priced at, not a platform share.
   */
  it("takes no share of the tip beyond the fee", () => {
    const { netCents } = tipPassThrough(10000);
    expect(netCents).toBeGreaterThan(10000 * 0.96);
  });

  /**
   * The fixed 30¢ is absent on purpose. A tip rides on the invoice charge that
   * was happening anyway, and that charge pays the fixed fee whether or not a
   * tip is added — so charging her a share of it is billing her for something
   * the business was going to pay regardless.
   */
  it("does not deduct the fixed per-transaction fee", () => {
    const { feeCents } = tipPassThrough(500);
    expect(feeCents).toBeLessThan(30);
    expect(feeCents).toBe(14); // 2.9% of 500, floored
  });

  /** The fraction goes to her, not to the business. */
  it("rounds the fee down so the cleaner keeps the fraction", () => {
    // 2.9% of 1000 is 29.0 exactly; of 1050 it is 30.45 → 30, not 31.
    expect(tipPassThrough(1050).feeCents).toBe(30);
    expect(tipPassThrough(1050).netCents).toBe(1020);
  });

  /** A tip that does not reconcile is one somebody accounts for by hand. */
  it("always reconciles: fee plus net is the tip", () => {
    for (const tip of [0, 1, 7, 99, 100, 333, 1234, 2500, 9999, 100000]) {
      const split = tipPassThrough(tip);
      expect(split.feeCents + split.netCents).toBe(tip);
      expect(split.feeCents).toBeGreaterThanOrEqual(0);
      expect(split.netCents).toBeGreaterThanOrEqual(0);
    }
  });

  /** A tip too small to attract a whole cent of fee is passed on whole. */
  it("passes a very small tip through untouched", () => {
    expect(tipPassThrough(10)).toEqual({ tipCents: 10, feeCents: 0, netCents: 10 });
    expect(tipPassThrough(0)).toEqual({ tipCents: 0, feeCents: 0, netCents: 0 });
  });

  it("refuses fractional cents rather than inventing a rounding", () => {
    expect(() => tipPassThrough(10.5)).toThrow(BillingError);
  });

  it("refuses a negative tip", () => {
    expect(() => tipPassThrough(-100)).toThrow(BillingError);
  });

  it("takes a negotiated rate, and refuses one that is not a fraction", () => {
    expect(tipPassThrough(2000, 0.02).feeCents).toBe(40);
    expect(() => tipPassThrough(2000, 1.5)).toThrow(BillingError);
    expect(() => tipPassThrough(2000, -0.01)).toThrow(BillingError);
  });

  it("uses the standard card rate by default", () => {
    expect(tipPassThrough(10000).feeCents).toBe(Math.floor(10000 * CARD_PERCENTAGE_FEE));
  });
});

describe("tipDisclosure", () => {
  /**
   * The design said "100% goes to Maria". It is very nearly true and it is not
   * quite true, and a promise about somebody else's money is not the thing to
   * round.
   */
  it("names the cleaner and the one deduction, without overclaiming", () => {
    const line = tipDisclosure("Maria");
    expect(line).toContain("Maria");
    expect(line).toContain("card processing fee");
    expect(line).not.toContain("100%");
  });
});
