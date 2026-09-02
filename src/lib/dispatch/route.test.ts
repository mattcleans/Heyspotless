import { describe, expect, it } from "vitest";
import { clusterDay, constantEstimator, forecastWeek, haversineMiles, zipCentroidEstimator } from "./route";
import { shonda } from "./fixtures";
import type { DispatchJob } from "./types";

const AVERAGE_TICKET = 17000; // $170, the real figure from the plan

function week(driveMinutesPerJob: number, jobs = 15, cleanMinutes = 150) {
  return Array.from({ length: jobs }, () => ({ cleanMinutes, driveMinutes: driveMinutesPerJob }));
}

describe("weekly overtime forecast (plan section 05)", () => {
  /**
   * The plan's drive-time table. Four of the five rows reproduce exactly. The
   * 20-minute row is an arithmetic slip in the document: its own stated inputs
   * (2.5 overtime hours) give $880.47, not the $878.96 printed. Every other row
   * matches the same formula to the cent, so the formula is right and that one
   * cell is wrong — asserted here deliberately so the discrepancy is recorded
   * rather than quietly reproduced.
   */
  const rows = [
    { driveMin: 10, driving: 2.5,  total: 40.0,  ot: 0.0,  cost: 80500,  perJob: 5367, pct: 0.316 },
    { driveMin: 15, driving: 3.75, total: 41.25, ot: 1.25, cost: 84273,  perJob: 5618, pct: 0.330 },
    { driveMin: 30, driving: 7.5,  total: 45.0,  ot: 5.0,  cost: 95594,  perJob: 6373, pct: 0.375 },
    { driveMin: 45, driving: 11.25, total: 48.75, ot: 8.75, cost: 106914, perJob: 7128, pct: 0.419 },
  ];

  for (const row of rows) {
    it(`${row.driveMin} min average drive → ${row.ot}h overtime, $${(row.cost / 100).toFixed(2)}/wk`, () => {
      const f = forecastWeek(shonda(), week(row.driveMin), AVERAGE_TICKET);
      expect(f.driveMinutes / 60).toBeCloseTo(row.driving, 2);
      expect(f.totalHours).toBeCloseTo(row.total, 2);
      expect(f.overtimeHours).toBeCloseTo(row.ot, 2);
      expect(f.weeklyCostCents).toBe(row.cost);
      expect(f.costPerJobCents).toBe(row.perJob);
      expect(f.shareOfTicket).toBeCloseTo(row.pct, 3);
    });
  }

  it("20-minute row: the plan prints $878.96, but its own inputs give $880.47", () => {
    const f = forecastWeek(shonda(), week(20), AVERAGE_TICKET);
    expect(f.overtimeHours).toBe(2.5); // as the plan states
    expect(f.weeklyCostCents).toBe(88047); // 40h guaranteed + 2.5h at time-and-a-half
    expect(f.weeklyCostCents).not.toBe(87896);
  });

  it("15 jobs a week is an overtime schedule, not a 40-hour one", () => {
    // The plan's correction: 15 x 2.5h is 37.5 cleaning hours, leaving 2.5 of
    // the guaranteed 40 for all driving — ten minutes a job, which is not real.
    const atTenMinutes = forecastWeek(shonda(), week(10), AVERAGE_TICKET);
    expect(atTenMinutes.overtimeHours).toBe(0);

    const atTwenty = forecastWeek(shonda(), week(20), AVERAGE_TICKET);
    expect(atTwenty.totalHours).toBeGreaterThan(40);
    expect(atTwenty.overtimeHours).toBeGreaterThan(0);
  });

  it("tightening 30 minutes to 15 saves about $5,900 a year", () => {
    const at30 = forecastWeek(shonda(), week(30), AVERAGE_TICKET).weeklyCostCents;
    const at15 = forecastWeek(shonda(), week(15), AVERAGE_TICKET).weeklyCostCents;
    const annual = (at30 - at15) * 52;
    // The plan claims $5,887/yr. More than twice the $2,748 HCP saving.
    expect(annual / 100).toBeGreaterThan(5800);
    expect(annual / 100).toBeLessThan(6000);
    expect(annual / 100).toBeGreaterThan(2748 * 2);
  });

  it("a light week still costs the full guarantee", () => {
    const light = forecastWeek(shonda(), week(10, 4), AVERAGE_TICKET);
    expect(light.totalHours).toBeLessThan(40);
    expect(light.weeklyCostCents).toBe(80500); // 40h paid regardless
  });
});

describe("clustering", () => {
  const centroids = {
    // Roughly Plano, Frisco, Allen — tight cluster.
    "75024": { latitude: 33.0751, longitude: -96.8236 },
    "75034": { latitude: 33.1507, longitude: -96.8236 },
    "75002": { latitude: 33.1032, longitude: -96.6706 },
    // Far side of the metroplex.
    "76102": { latitude: 32.7555, longitude: -97.3308 },
  };
  const estimate = zipCentroidEstimator(centroids);

  const job = (id: string, zip: string): DispatchJob => ({
    id,
    zip,
    priceCents: 17000,
    estimatedCleanMinutes: 150,
    scheduledStart: null,
  });

  it("orders a day to minimise driving", () => {
    const jobs = [job("far", "76102"), job("near", "75034"), job("mid", "75002")];
    const clustered = clusterDay(jobs, "75024", estimate);
    // Starting in Plano, Fort Worth must not come first.
    expect(clustered.ordered[0]!.id).not.toBe("far");
    expect(clustered.ordered.at(-1)!.id).toBe("far");
  });

  it("beats chronological order on total drive time", () => {
    const jobs = [job("far", "76102"), job("a", "75034"), job("b", "75002"), job("c", "75024")];
    const clustered = clusterDay(jobs, "75024", estimate);

    let chronological = 0;
    let cursor: string | undefined = "75024";
    for (const j of jobs) {
      chronological += estimate(cursor, j.zip).minutes;
      cursor = j.zip;
    }

    expect(clustered.totalDriveMinutes).toBeLessThan(chronological);
  });

  it("charges no drive for the first job of the day", () => {
    const clustered = clusterDay([job("a", "75034")], undefined, estimate);
    expect(clustered.totalDriveMinutes).toBe(0);
  });

  it("handles an empty day", () => {
    expect(clusterDay([], "75024", estimate).ordered).toEqual([]);
  });
});

describe("distance", () => {
  it("computes a sane DFW distance", () => {
    // Plano to downtown Fort Worth is roughly 35 miles straight line.
    const miles = haversineMiles(
      { latitude: 33.0751, longitude: -96.8236 },
      { latitude: 32.7555, longitude: -97.3308 },
    );
    expect(miles).toBeGreaterThan(30);
    expect(miles).toBeLessThan(40);
  });

  it("constantEstimator gives no drive from an unset origin", () => {
    const e = constantEstimator(20, 12);
    expect(e(undefined, "75024")).toEqual({ minutes: 0, miles: 0 });
    expect(e("75034", "75024")).toEqual({ minutes: 20, miles: 12 });
  });
});
