import { describe, expect, it } from "vitest";
import { MINIMUM_RATING, checkEligibility, eligibleCleaners } from "./eligibility";
import { contractor, shonda } from "./fixtures";
import type { DispatchJob } from "./types";

const JOB: DispatchJob = {
  id: "j1",
  priceCents: 17000,
  estimatedCleanMinutes: 138,
  zip: "75024",
  scheduledStart: new Date("2026-09-10T15:00:00Z"),
};

describe("the 3.9 rating floor", () => {
  it("is non-negotiable — below it a cleaner sees no jobs at all", () => {
    const weak = contractor({ rating: 3.8 });
    const result = checkEligibility(weak, JOB);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("below_rating_floor");
  });

  it("admits a cleaner exactly at the floor", () => {
    expect(checkEligibility(contractor({ rating: MINIMUM_RATING }), JOB).eligible).toBe(true);
  });

  it("treats an unrated cleaner as ineligible, not as above the floor by default", () => {
    const result = checkEligibility(contractor({ rating: null }), JOB);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("unrated");
  });
});

describe("hard gates", () => {
  it("blocks a cleaner whose background check has not cleared", () => {
    const result = checkEligibility(contractor({ backgroundCheckCleared: false }), JOB);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("background_not_cleared");
  });

  it("blocks lapsed insurance as of the job date", () => {
    const lapsed = contractor({ insuranceExpiresOn: new Date("2026-09-01T00:00:00Z") });
    expect(checkEligibility(lapsed, JOB).reasons).toContain("insurance_expired");

    const current = contractor({ insuranceExpiresOn: new Date("2027-01-01T00:00:00Z") });
    expect(checkEligibility(current, JOB).eligible).toBe(true);
  });

  it("blocks a cleaner outside their service zone", () => {
    const elsewhere = contractor({ serviceZips: ["76102"] });
    expect(checkEligibility(elsewhere, JOB).reasons).toContain("outside_service_zone");
  });

  it("treats an empty zone list as working anywhere", () => {
    expect(checkEligibility(contractor({ serviceZips: [] }), JOB).eligible).toBe(true);
  });

  it("blocks a cleaner who is not active", () => {
    expect(checkEligibility(contractor({ status: "paused" }), JOB).reasons).toContain("not_active");
  });

  it("blocks a double booking in an overlapping window", () => {
    const busy = checkEligibility(contractor(), JOB, {
      busyWindows: [
        {
          start: new Date("2026-09-10T14:00:00Z"),
          end: new Date("2026-09-10T16:30:00Z"),
        },
      ],
    });
    expect(busy.reasons).toContain("already_booked");
  });

  it("allows a non-overlapping booking the same day", () => {
    const free = checkEligibility(contractor(), JOB, {
      busyWindows: [
        {
          start: new Date("2026-09-10T08:00:00Z"),
          end: new Date("2026-09-10T10:00:00Z"),
        },
      ],
    });
    expect(free.eligible).toBe(true);
  });
});

describe("reporting", () => {
  it("collects every reason, not just the first", () => {
    const bad = contractor({
      rating: 2.0,
      backgroundCheckCleared: false,
      status: "terminated",
      serviceZips: ["76102"],
    });
    const result = checkEligibility(bad, JOB);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "not_active",
        "below_rating_floor",
        "background_not_cleared",
        "outside_service_zone",
      ]),
    );
  });

  it("filters a roster down to those who pass", () => {
    const roster = [
      shonda(),
      contractor({ id: "ok", rating: 4.5 }),
      contractor({ id: "low", rating: 3.0 }),
      contractor({ id: "unchecked", backgroundCheckCleared: false }),
    ];
    expect(eligibleCleaners(roster, JOB).map((c) => c.id)).toEqual(["shonda", "ok"]);
  });
});

describe("declared working hours", () => {
  const NOON = new Date("2026-09-10T17:00:00Z"); // 12:00 in Chicago

  const job = (): DispatchJob => ({
    id: "job-hours",
    priceCents: 17000,
    estimatedCleanMinutes: 120,
    zip: "75024",
    scheduledStart: NOON,
  });

  const window = (fromHours: number, toHours: number) => ({
    start: new Date(NOON.getTime() + fromHours * 3_600_000),
    end: new Date(NOON.getTime() + toHours * 3_600_000),
  });

  it("treats no declaration as unknown, not as 'works no hours'", () => {
    // Nobody on the roster has declared availability yet. Reading that as
    // "never available" would make every cleaner ineligible for everything
    // the moment the check shipped.
    const result = checkEligibility(contractor(), job(), {});
    expect(result.eligible).toBe(true);
  });

  it("honours an empty declaration as 'not working that day'", () => {
    const result = checkEligibility(contractor(), job(), { workingWindows: [] });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("outside_working_hours");
  });

  it("accepts a job that fits inside a declared window", () => {
    const result = checkEligibility(contractor(), job(), {
      workingWindows: [window(-3, 5)],
    });
    expect(result.eligible).toBe(true);
  });

  it("refuses a job that starts inside the window but runs past the end", () => {
    // She works until 13:00 and the clean takes two hours. Offering it to her
    // is offering her an hour of unpaid overtime she did not agree to.
    const result = checkEligibility(contractor(), job(), {
      workingWindows: [window(-3, 1)],
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("outside_working_hours");
  });

  it("does not stitch two adjacent windows into one", () => {
    // A split shift is two shifts. A clean spanning the gap is not a clean
    // she can do, however tidily the hours add up.
    const result = checkEligibility(contractor(), job(), {
      workingWindows: [window(-3, 1), window(1, 5)],
    });
    expect(result.eligible).toBe(false);
  });

  it("says nothing about hours for a job with no scheduled start", () => {
    const result = checkEligibility(
      contractor(),
      { ...job(), scheduledStart: null },
      { workingWindows: [] },
    );
    expect(result.reasons).not.toContain("outside_working_hours");
  });
});
