import { describe, expect, it } from "vitest";
import { bestFrequencySaving, frequencySaving } from "./discount";
import { buildQuote } from "./quote";

const HOME = { bedrooms: 3, bathrooms: 2, halfBaths: 0, kitchens: 1, livingRooms: 1, utilityRooms: 1 };

describe("frequencySaving", () => {
  it("is the real difference between the two prices in the book", () => {
    const saving = frequencySaving("standard", "biweekly", HOME);
    expect(saving).not.toBeNull();

    const oneTime = buildQuote("standard", "one_time", HOME).totalCents;
    const biweekly = buildQuote("standard", "biweekly", HOME).totalCents;

    expect(saving!.oneTimeCents).toBe(oneTime);
    expect(saving!.frequencyCents).toBe(biweekly);
    expect(saving!.savingCents).toBe(oneTime - biweekly);
  });

  /** A saving that cannot disagree with the price, because it is the price. */
  it("agrees with the quote engine by construction", () => {
    for (const frequency of ["weekly", "biweekly", "monthly"] as const) {
      const saving = frequencySaving("standard", frequency, HOME);
      if (!saving) continue;
      expect(saving.oneTimeCents - saving.savingCents).toBe(saving.frequencyCents);
    }
  });

  it("saves more the more often you book", () => {
    const weekly = frequencySaving("standard", "weekly", HOME);
    const monthly = frequencySaving("standard", "monthly", HOME);
    expect(weekly!.savingCents).toBeGreaterThan(monthly!.savingCents);
  });

  it("has nothing to show for a one-off", () => {
    expect(frequencySaving("standard", "one_time", HOME)).toBeNull();
  });

  /**
   * Move In/Out is one-time only, so there is no recurring rate to be cheaper
   * than — and a "discount" on a service you cannot book repeatedly is a lie.
   */
  it("has nothing to show for a service that is only sold one-time", () => {
    expect(frequencySaving("move_in_out", "weekly", HOME)).toBeNull();
  });

  it("reports the saving as a fraction, for the badge", () => {
    const saving = frequencySaving("standard", "weekly", HOME)!;
    expect(saving.savingFraction).toBeCloseTo(saving.savingCents / saving.oneTimeCents, 10);
    expect(saving.savingFraction).toBeGreaterThan(0);
    expect(saving.savingFraction).toBeLessThan(1);
  });

  it("scales with the house rather than quoting a marketing figure", () => {
    const small = frequencySaving("standard", "weekly", { ...HOME, bedrooms: 1, bathrooms: 1 })!;
    const large = frequencySaving("standard", "weekly", { ...HOME, bedrooms: 5, bathrooms: 4 })!;
    expect(large.savingCents).toBeGreaterThan(small.savingCents);
  });
});

describe("bestFrequencySaving", () => {
  it("is the largest available, for the badge above the picker", () => {
    const best = bestFrequencySaving("standard", HOME)!;
    const weekly = frequencySaving("standard", "weekly", HOME)!;
    expect(best.savingCents).toBe(weekly.savingCents);
  });

  it("is null where nothing recurring is sold", () => {
    expect(bestFrequencySaving("move_in_out", HOME)).toBeNull();
  });
});
