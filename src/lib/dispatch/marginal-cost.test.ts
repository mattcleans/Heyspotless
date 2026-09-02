import { describe, expect, it } from "vitest";
import {
  cheapestW2Option,
  fitsInGuaranteedHours,
  mileageRateCentsPerMile,
  unspentGuaranteedCents,
  unspentGuaranteedHours,
  w2MarginalCost,
} from "./marginal-cost";
import { iggy, shonda } from "./fixtures";

/**
 * Every expected figure below is quoted from section 04 or 05 of the build
 * plan, not computed by the code under test. If the cost model drifts from the
 * document Matt approved, these fail.
 */

const JULY = new Date("2026-08-15T15:00:00Z"); // after the IRS midyear increase

describe("Shonda's marginal job (plan section 04, table 1)", () => {
  // A 2.5-hour job, with Shonda already past 40 hours so every hour is overtime.
  const atCapacity = shonda({ hoursScheduledThisWeek: 40 });

  const cases = [
    { label: "overtime, cleaning hours only", driveMin: 0, expected: 7547, pctOf170: 0.444 },
    { label: "overtime + 15 min paid drive", driveMin: 15, expected: 8302, pctOf170: 0.488 },
    { label: "overtime + 30 min paid drive", driveMin: 30, expected: 9056, pctOf170: 0.533 },
  ];

  for (const c of cases) {
    it(`${c.label} costs $${(c.expected / 100).toFixed(2)}`, () => {
      const cost = w2MarginalCost(atCapacity, {
        cleanMinutes: 150,
        drive: { minutes: c.driveMin, miles: 0 },
        jobDate: JULY,
      });
      expect(cost?.marginalCents).toBe(c.expected);
    });

    it(`${c.label} is ${(c.pctOf170 * 100).toFixed(1)}% of a $170 ticket`, () => {
      const cost = w2MarginalCost(atCapacity, {
        cleanMinutes: 150,
        drive: { minutes: c.driveMin, miles: 0 },
        jobDate: JULY,
      });
      expect((cost?.marginalCents ?? 0) / 17000).toBeCloseTo(c.pctOf170, 3);
    });
  }

  it("drives the company truck, so mileage is never reimbursed", () => {
    const cost = w2MarginalCost(atCapacity, {
      cleanMinutes: 150,
      drive: { minutes: 30, miles: 18 },
      jobDate: JULY,
    });
    expect(cost?.mileageCents).toBe(0);
  });

  it("crosses the 50% ceiling at a 30-minute drive — this is why a flat cap fails", () => {
    const at15 = w2MarginalCost(atCapacity, {
      cleanMinutes: 150,
      drive: { minutes: 15, miles: 0 },
      jobDate: JULY,
    });
    const at30 = w2MarginalCost(atCapacity, {
      cleanMinutes: 150,
      drive: { minutes: 30, miles: 0 },
      jobDate: JULY,
    });
    const ceiling = 17000 * 0.5;
    expect(at15!.marginalCents).toBeLessThan(ceiling);
    expect(at30!.marginalCents).toBeGreaterThan(ceiling);
  });
});

describe("Iggy vs Shonda's overtime (plan section 04, table 2)", () => {
  // A 2.3-hour job — the weekly/bi-weekly 2bd/2ba that is the bread and butter.
  const CLEAN_MINUTES = 138;
  const atCapacity = shonda({ hoursScheduledThisWeek: 40 });
  const partTime = iggy({ hoursScheduledThisWeek: 10 });

  const rows = [
    { driveMin: 10, miles: 6,  iggyWage: 5957, mileage: 456,  iggyTotal: 6413, shonda: 7446 },
    { driveMin: 20, miles: 12, iggyWage: 6359, mileage: 912,  iggyTotal: 7271, shonda: 7949 },
    { driveMin: 30, miles: 18, iggyWage: 6762, mileage: 1368, iggyTotal: 8130, shonda: 8452 },
    { driveMin: 40, miles: 24, iggyWage: 7165, mileage: 1824, iggyTotal: 8989, shonda: 8956 },
  ];

  for (const row of rows) {
    it(`${row.driveMin} min / ${row.miles} mi — Iggy $${(row.iggyTotal / 100).toFixed(2)}, Shonda $${(row.shonda / 100).toFixed(2)}`, () => {
      const inputs = {
        cleanMinutes: CLEAN_MINUTES,
        drive: { minutes: row.driveMin, miles: row.miles },
        jobDate: JULY,
      };

      const i = w2MarginalCost(partTime, inputs)!;
      // Within a cent: three rows of this table land on an exact half cent and
      // the plan rounds them inconsistently. See the note in marginal-cost.ts.
      expect(Math.abs(i.wageCents - row.iggyWage)).toBeLessThanOrEqual(1);
      expect(i.mileageCents).toBe(row.mileage); // mileage is never on a boundary
      expect(Math.abs(i.marginalCents - row.iggyTotal)).toBeLessThanOrEqual(1);

      const s = w2MarginalCost(atCapacity, inputs)!;
      expect(Math.abs(s.marginalCents - row.shonda)).toBeLessThanOrEqual(1);
    });
  }

  it("Iggy is cheaper up to about a 40-minute drive, then Shonda's overtime wins", () => {
    const compare = (driveMin: number, miles: number) => {
      const inputs = { cleanMinutes: CLEAN_MINUTES, drive: { minutes: driveMin, miles }, jobDate: JULY };
      return {
        iggy: w2MarginalCost(partTime, inputs)!.marginalCents,
        shonda: w2MarginalCost(atCapacity, inputs)!.marginalCents,
      };
    };

    const short = compare(10, 6);
    expect(short.iggy).toBeLessThan(short.shonda);

    // The crossover the plan identifies: past ~40 minutes the ordering flips.
    const long = compare(40, 24);
    expect(long.iggy).toBeGreaterThan(long.shonda);
  });

  it("rounds a half cent up, consistently, rather than reproducing float error", () => {
    // 2.3h + 40min at $21/hr with a 15% burden is exactly 7164.5 cents.
    // The plan rounds this row up but rounds the 20-minute row (6359.5) down;
    // both are half cents. Integer arithmetic rounds both the same way.
    const at40 = w2MarginalCost(partTime, {
      cleanMinutes: CLEAN_MINUTES,
      drive: { minutes: 40, miles: 0 },
      jobDate: JULY,
    })!;
    expect(at40.wageCents).toBe(7165);

    const at20 = w2MarginalCost(partTime, {
      cleanMinutes: CLEAN_MINUTES,
      drive: { minutes: 20, miles: 0 },
      jobDate: JULY,
    })!;
    expect(at20.wageCents).toBe(6360); // plan prints 6359

    const shondaAt30 = w2MarginalCost(atCapacity, {
      cleanMinutes: CLEAN_MINUTES,
      drive: { minutes: 30, miles: 0 },
      jobDate: JULY,
    })!;
    expect(shondaAt30.wageCents).toBe(8453); // plan prints 8452
  });

  it("cheapestW2Option picks whichever actually wins for this job", () => {
    const near = cheapestW2Option([atCapacity, partTime], () => ({
      cleanMinutes: CLEAN_MINUTES,
      drive: { minutes: 10, miles: 6 },
      jobDate: JULY,
    }));
    expect(near?.cleaner.id).toBe("iggy");

    const far = cheapestW2Option([atCapacity, partTime], () => ({
      cleanMinutes: CLEAN_MINUTES,
      drive: { minutes: 40, miles: 24 },
      jobDate: JULY,
    }));
    expect(far?.cleaner.id).toBe("shonda");
  });
});

describe("guaranteed hours are a sunk cost", () => {
  it("a job inside the guarantee has a marginal cost of zero", () => {
    const idle = shonda({ hoursScheduledThisWeek: 10 });
    const cost = w2MarginalCost(idle, {
      cleanMinutes: 150,
      drive: { minutes: 20, miles: 10 },
      jobDate: JULY,
    });
    expect(cost?.marginalCents).toBe(0);
    expect(cost?.sunkHours).toBeCloseTo(2.833, 3);
    expect(fitsInGuaranteedHours(idle, { cleanMinutes: 150, drive: { minutes: 20, miles: 10 } })).toBe(true);
  });

  it("but the hours still cost real money — reporting sees the full burden", () => {
    const idle = shonda({ hoursScheduledThisWeek: 10 });
    const cost = w2MarginalCost(idle, {
      cleanMinutes: 150,
      drive: { minutes: 20, miles: 10 },
      jobDate: JULY,
    })!;
    expect(cost.marginalCents).toBe(0);
    expect(cost.fullyBurdenedCents).toBeGreaterThan(0);
  });

  it("a job straddling the 40-hour line is split, not billed wholly as overtime", () => {
    const nearlyFull = shonda({ hoursScheduledThisWeek: 39 });
    const cost = w2MarginalCost(nearlyFull, {
      cleanMinutes: 150,
      drive: { minutes: 0, miles: 0 },
      jobDate: JULY,
    })!;
    expect(cost.sunkHours).toBe(1); // the last guaranteed hour
    expect(cost.overtimeHours).toBeCloseTo(1.5, 5);
    // 1.5 OT hours only, not the full 2.5.
    expect(cost.marginalCents).toBe(Math.round(1.5 * 2625 * 1.15));
  });

  it("reports unspent guaranteed hours for the idle-hours alert", () => {
    const idle = shonda({ hoursScheduledThisWeek: 30 });
    expect(unspentGuaranteedHours(idle)).toBe(10);
    // The plan's dashboard tile: "10 unfilled hours — $201 already spent".
    expect(unspentGuaranteedCents(idle)).toBe(20125);
  });

  it("a part-timer with no guarantee has nothing sunk", () => {
    const cost = w2MarginalCost(iggy({ hoursScheduledThisWeek: 0 }), {
      cleanMinutes: 138,
      drive: { minutes: 0, miles: 0 },
      jobDate: JULY,
    })!;
    expect(cost.sunkHours).toBe(0);
    expect(cost.marginalCents).toBeGreaterThan(0);
  });
});

describe("IRS mileage rate", () => {
  it("is 72.5 cents in the first half of 2026", () => {
    expect(mileageRateCentsPerMile(new Date("2026-03-01T00:00:00Z"))).toBe(72.5);
  });

  it("rises to 76 cents from 1 July 2026 — the first midyear change since 2022", () => {
    expect(mileageRateCentsPerMile(new Date("2026-07-01T00:00:00Z"))).toBe(76);
    expect(mileageRateCentsPerMile(new Date("2026-12-31T00:00:00Z"))).toBe(76);
  });

  it("applies the rate in effect on the job date, not today", () => {
    const inputs = (jobDate: Date) => ({ cleanMinutes: 138, drive: { minutes: 20, miles: 12 }, jobDate });
    const spring = w2MarginalCost(iggy(), inputs(new Date("2026-03-01T00:00:00Z")))!;
    const autumn = w2MarginalCost(iggy(), inputs(new Date("2026-09-01T00:00:00Z")))!;
    expect(spring.mileageCents).toBe(870); // 12 x 72.5
    expect(autumn.mileageCents).toBe(912); // 12 x 76
  });
});

describe("contractors", () => {
  it("have no W-2 marginal cost — their price is whatever the auction clears at", () => {
    const c = { ...iggy(), terms: undefined };
    expect(w2MarginalCost(c, { cleanMinutes: 138, drive: { minutes: 0, miles: 0 } })).toBeNull();
  });
});

describe("unpaid drive time", () => {
  it("is the FLSA exposure the plan flags — modeling it as unpaid understates cost", () => {
    const paid = shonda({ hoursScheduledThisWeek: 40 });
    const unpaid = shonda({
      hoursScheduledThisWeek: 40,
      terms: { ...paid.terms!, driveTimePaid: false },
    });
    const inputs = { cleanMinutes: 138, drive: { minutes: 20, miles: 12 }, jobDate: JULY };
    expect(w2MarginalCost(unpaid, inputs)!.marginalCents).toBeLessThan(
      w2MarginalCost(paid, inputs)!.marginalCents,
    );
  });
});
