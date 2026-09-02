import { describe, expect, it } from "vitest";
import { PriceBookError, buildQuote, estimatedHours } from "./quote";
import { FREQUENCIES, PRICE_BOOK, frequenciesForService } from "./price-book";

/**
 * These totals are not derived from the code under test. They are the published
 * Hey Spotless quote table effective 9 August 2026, reproduced from the
 * pricelist itself. If the price book is edited carelessly, this suite is what
 * catches it — and the identical assertions run against the SQL implementation
 * in scripts/verify-migrations.sh, so the two can never silently diverge.
 *
 * Table assumption, stated in the pricelist: 1 kitchen + 1 living/dining +
 * 1 utility room.
 */
const PUBLISHED_TOTALS = [
  { beds: 1, baths: 1, standard: 15700, deep: 25800, move_in_out: 32400 },
  { beds: 2, baths: 1, standard: 17700, deep: 29200, move_in_out: 36300 },
  { beds: 2, baths: 2, standard: 19900, deep: 32800, move_in_out: 40800 },
  { beds: 3, baths: 2, standard: 21900, deep: 36200, move_in_out: 44700 },
  { beds: 3, baths: 3, standard: 24100, deep: 39800, move_in_out: 49200 },
  { beds: 4, baths: 2, standard: 23900, deep: 39600, move_in_out: 48600 },
  { beds: 4, baths: 3, standard: 26100, deep: 43200, move_in_out: 53100 },
  { beds: 5, baths: 3, standard: 28100, deep: 46600, move_in_out: 57000 },
  { beds: 6, baths: 4, standard: 32300, deep: 53600, move_in_out: 65400 },
] as const;

describe("published one-time quote table (9 Aug 2026)", () => {
  for (const row of PUBLISHED_TOTALS) {
    const rooms = { bedrooms: row.beds, bathrooms: row.baths };

    it(`standard ${row.beds}bd/${row.baths}ba = $${row.standard / 100}`, () => {
      expect(buildQuote("standard", "one_time", rooms).totalCents).toBe(row.standard);
    });

    it(`deep ${row.beds}bd/${row.baths}ba = $${row.deep / 100}`, () => {
      expect(buildQuote("deep", "one_time", rooms).totalCents).toBe(row.deep);
    });

    it(`move-in/out ${row.beds}bd/${row.baths}ba = $${row.move_in_out / 100}`, () => {
      expect(buildQuote("move_in_out", "one_time", rooms).totalCents).toBe(row.move_in_out);
    });
  }
});

describe("recurring rates", () => {
  // These four appear in the build plan's payout table. The recurring discount
  // is already inside the rate columns — a multiplier applied on top would
  // reproduce none of them.
  it("weekly 2bd/2ba = $160", () => {
    expect(buildQuote("standard", "weekly", { bedrooms: 2, bathrooms: 2 }).totalCents).toBe(16000);
  });

  it("bi-weekly 2bd/2ba = $170 — the average ticket", () => {
    expect(buildQuote("standard", "biweekly", { bedrooms: 2, bathrooms: 2 }).totalCents).toBe(17000);
  });

  it("weekly is cheaper than bi-weekly is cheaper than monthly is cheaper than one-time", () => {
    const at = (f: "weekly" | "biweekly" | "monthly" | "one_time") =>
      buildQuote("standard", f, { bedrooms: 3, bathrooms: 2 }).totalCents;
    expect(at("weekly")).toBeLessThan(at("biweekly"));
    expect(at("biweekly")).toBeLessThan(at("monthly"));
    expect(at("monthly")).toBeLessThan(at("one_time"));
  });

  it("the recurring discount is never applied twice", () => {
    // A 15% multiplier on the one-time price would give 18615, not 17000.
    const oneTime = buildQuote("standard", "one_time", { bedrooms: 2, bathrooms: 2 }).totalCents;
    const biweekly = buildQuote("standard", "biweekly", { bedrooms: 2, bathrooms: 2 }).totalCents;
    expect(biweekly).toBe(17000);
    expect(biweekly).not.toBe(Math.round(oneTime * 0.85));
  });
});

describe("estimated duration", () => {
  // The build plan's payout table quotes these hours; payout is computed from
  // them, so they are load-bearing rather than cosmetic.
  const cases = [
    { label: "weekly 2bd/2ba", service: "standard", freq: "weekly", beds: 2, baths: 2, hours: 2.3 },
    { label: "one-time 3bd/2ba", service: "standard", freq: "one_time", beds: 3, baths: 2, hours: 2.55 },
    { label: "deep 3bd/2ba", service: "deep", freq: "one_time", beds: 3, baths: 2, hours: 4.82 },
    { label: "move-out 4bd/4ba", service: "move_in_out", freq: "one_time", beds: 4, baths: 4, hours: 8.05 },
  ] as const;

  for (const c of cases) {
    it(`${c.label} is about ${c.hours}h`, () => {
      const q = buildQuote(c.service, c.freq, { bedrooms: c.beds, bathrooms: c.baths });
      expect(estimatedHours(q)).toBeCloseTo(c.hours, 2);
    });
  }
});

describe("extras", () => {
  it("are added on top and never discounted", () => {
    const base = buildQuote("standard", "weekly", { bedrooms: 2, bathrooms: 2 });
    const withExtras = buildQuote("standard", "weekly", { bedrooms: 2, bathrooms: 2 }, [
      { itemKey: "oven" },
      { itemKey: "refrigerator" },
    ]);
    // $50 oven + $25 fridge, at full price despite the weekly frequency.
    expect(withExtras.extrasCents).toBe(7500);
    expect(withExtras.totalCents).toBe(base.totalCents + 7500);
  });

  it("respect quantity for per-unit extras", () => {
    const q = buildQuote("standard", "one_time", { bedrooms: 1, bathrooms: 1 }, [
      { itemKey: "laundry", quantity: 3 },
    ]);
    expect(q.extrasCents).toBe(6000);
  });

  it("add their own time to the estimate", () => {
    const base = buildQuote("standard", "one_time", { bedrooms: 2, bathrooms: 2 });
    const withOven = buildQuote("standard", "one_time", { bedrooms: 2, bathrooms: 2 }, [
      { itemKey: "oven" },
    ]);
    expect(withOven.estimatedMinutes).toBe(base.estimatedMinutes + 30);
  });

  it("reject an unknown extra rather than pricing it at zero", () => {
    expect(() =>
      buildQuote("standard", "one_time", { bedrooms: 2, bathrooms: 2 }, [{ itemKey: "window_tint" }]),
    ).toThrow(PriceBookError);
  });
});

describe("half baths", () => {
  it("are a separate line, not a fractional bathroom", () => {
    // Zillow "2.5 ba" = 2 full + 1 half.
    const q = buildQuote("standard", "one_time", { bedrooms: 3, bathrooms: 2, halfBaths: 1 });
    const base = buildQuote("standard", "one_time", { bedrooms: 3, bathrooms: 2 });
    expect(q.totalCents).toBe(base.totalCents + 1100);
    expect(q.lines.find((l) => l.itemKey === "half_bath")?.quantity).toBe(1);
  });

  it("are omitted entirely when there are none", () => {
    const q = buildQuote("standard", "one_time", { bedrooms: 3, bathrooms: 2 });
    expect(q.lines.some((l) => l.itemKey === "half_bath")).toBe(false);
  });
});

describe("service and frequency combinations", () => {
  it("standard is sold at every frequency", () => {
    expect(frequenciesForService("standard")).toEqual([...FREQUENCIES]);
  });

  it("deep is one-time and monthly only", () => {
    expect(frequenciesForService("deep")).toEqual(["one_time", "monthly"]);
  });

  it("move-in/out is one-time only", () => {
    expect(frequenciesForService("move_in_out")).toEqual(["one_time"]);
  });

  it("throws on a combination that is not sold, rather than quoting $0", () => {
    // The bug this guards: a silent $0 quote sent to a real customer.
    expect(() => buildQuote("move_in_out", "weekly", { bedrooms: 3, bathrooms: 2 })).toThrow(
      PriceBookError,
    );
    expect(() => buildQuote("deep", "weekly", { bedrooms: 3, bathrooms: 2 })).toThrow(PriceBookError);
  });
});

describe("price book integrity", () => {
  it("has arrival plus six room types for all three services", () => {
    for (const service of ["standard", "deep", "move_in_out"] as const) {
      expect(PRICE_BOOK.filter((i) => i.service === service)).toHaveLength(7);
    }
  });

  it("charges arrival exactly once regardless of house size", () => {
    const small = buildQuote("standard", "one_time", { bedrooms: 1, bathrooms: 1 });
    const large = buildQuote("standard", "one_time", { bedrooms: 6, bathrooms: 4 });
    for (const q of [small, large]) {
      expect(q.lines.find((l) => l.itemKey === "arrival")?.quantity).toBe(1);
    }
  });

  it("prices every rate as a positive whole number of cents", () => {
    for (const item of PRICE_BOOK) {
      for (const [freq, cents] of Object.entries(item.rates)) {
        expect(Number.isInteger(cents), `${item.service}/${item.itemKey}/${freq}`).toBe(true);
        expect(cents).toBeGreaterThan(0);
      }
    }
  });

  it("rejects negative room counts", () => {
    expect(() => buildQuote("standard", "one_time", { bedrooms: -1, bathrooms: 2 })).toThrow(
      PriceBookError,
    );
  });
});
