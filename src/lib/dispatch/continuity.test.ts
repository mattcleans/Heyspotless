import { describe, expect, it } from "vitest";
import {
  HOLD_CAPS,
  MIN_LEAD_HOURS_FOR_HOLD,
  MIN_VISITS_FOR_INCUMBENCY,
  continuityPremiumCapCents,
  holdCostCents,
  holdWindowSeconds,
  resolveContinuity,
} from "./continuity";
import { contractor, shonda } from "./fixtures";
import { buildQuote } from "../pricing/quote";
import type { Cleaner, DispatchJob } from "./types";

const NOW = new Date("2026-09-01T14:00:00Z");

function job(overrides: Partial<DispatchJob> = {}): DispatchJob {
  const q = buildQuote("standard", "biweekly", { bedrooms: 2, bathrooms: 2 });
  return {
    id: "job-1",
    priceCents: q.totalCents,
    estimatedCleanMinutes: q.estimatedMinutes,
    zip: "75024",
    scheduledStart: new Date("2026-09-10T15:00:00Z"),
    ...overrides,
  };
}

const sarah = (overrides: Partial<Cleaner> = {}) =>
  contractor({ id: "sarah", name: "Sarah", ...overrides });

describe("the hold window scales with the lead time there is to spend", () => {
  it("gives a job three days out or more a full day", () => {
    expect(holdWindowSeconds(24 * 7)).toBe(HOLD_CAPS.relaxed);
  });

  it("never lets the hold eat more than a quarter of the remaining lead", () => {
    // 72h out: the 24h cap would be a third of the runway. 18h is a quarter.
    expect(holdWindowSeconds(72)).toBe(18 * 3600);
  });

  it("shortens to hours inside three days, and to minutes inside a day", () => {
    expect(holdWindowSeconds(48)).toBe(HOLD_CAPS.soon);
    expect(holdWindowSeconds(12)).toBe(HOLD_CAPS.urgent);
  });

  it("gives up entirely on a backfill — a dirty house beats a polite queue", () => {
    expect(holdWindowSeconds(MIN_LEAD_HOURS_FOR_HOLD - 0.1)).toBe(0);
    expect(holdWindowSeconds(0)).toBe(0);
  });

  it("caps an unscheduled job rather than holding it for ever", () => {
    expect(holdWindowSeconds(Number.POSITIVE_INFINITY)).toBe(HOLD_CAPS.relaxed);
  });
});

describe("who holds the job", () => {
  const options = { now: NOW, hoursUntilJob: 200 };

  it("nobody, when the home has no history", () => {
    const result = resolveContinuity(job(), [sarah()], options);
    expect(result.held).toBe(false);
    if (result.held) return;
    expect(result.reason).toBe("no_relationship");
  });

  it("the cleaner the customer asked for, with no visit threshold", () => {
    const result = resolveContinuity(
      job({
        continuity: {
          preferredCleanerId: "sarah",
          incumbentCleanerId: null,
          priorVisits: 0,
        },
      }),
      [sarah(), contractor()],
      options,
    );
    expect(result.held).toBe(true);
    if (!result.held) return;
    expect(result.cleaner.id).toBe("sarah");
    expect(result.basis).toBe("preferred");
  });

  it("a stated preference outranks whoever happened to come last", () => {
    const result = resolveContinuity(
      job({
        continuity: {
          preferredCleanerId: "sarah",
          incumbentCleanerId: "contractor-1",
          priorVisits: 9,
        },
      }),
      [sarah(), contractor()],
      options,
    );
    expect(result.held).toBe(true);
    if (!result.held) return;
    expect(result.cleaner.id).toBe("sarah");
  });

  it("falls to the incumbent once she has been enough times", () => {
    const withVisits = (priorVisits: number) =>
      resolveContinuity(
        job({
          continuity: {
            preferredCleanerId: null,
            incumbentCleanerId: "sarah",
            priorVisits,
          },
        }),
        [sarah()],
        options,
      );

    const tooFew = withVisits(MIN_VISITS_FOR_INCUMBENCY - 1);
    expect(tooFew.held).toBe(false);
    if (!tooFew.held) expect(tooFew.reason).toBe("too_few_visits");

    const enough = withVisits(MIN_VISITS_FOR_INCUMBENCY);
    expect(enough.held).toBe(true);
    if (enough.held) expect(enough.basis).toBe("incumbent");
  });

  it("does not hold for a cleaner the eligibility gate would refuse", () => {
    const result = resolveContinuity(
      job({
        continuity: {
          preferredCleanerId: "sarah",
          incumbentCleanerId: null,
          priorVisits: 20,
        },
      }),
      [sarah({ backgroundCheckCleared: false })],
      options,
    );
    expect(result.held).toBe(false);
    if (result.held) return;
    // Reported rather than silently absent: this customer is about to be
    // substituted and somebody should know why.
    expect(result.reason).toBe("incumbent_ineligible");
  });

  it("does not silently substitute the last cleaner for the requested one", () => {
    // Sarah was asked for and cannot take it; the contractor who came once
    // before does NOT quietly inherit the hold. That is a substitution, and a
    // substitution is a decision with the customer in it.
    const result = resolveContinuity(
      job({
        continuity: {
          preferredCleanerId: "sarah",
          incumbentCleanerId: "contractor-1",
          priorVisits: 5,
        },
      }),
      [sarah({ status: "paused" }), contractor()],
      options,
    );
    expect(result.held).toBe(false);
  });

  it("does not hold at all when there is no lead time left", () => {
    const result = resolveContinuity(
      job({
        continuity: { preferredCleanerId: "sarah", incumbentCleanerId: null, priorVisits: 9 },
      }),
      [sarah()],
      { now: NOW, hoursUntilJob: 1 },
    );
    expect(result.held).toBe(false);
    if (result.held) return;
    expect(result.reason).toBe("no_lead_time");
  });

  it("expires the hold at now plus the window", () => {
    const result = resolveContinuity(
      job({
        continuity: { preferredCleanerId: "sarah", incumbentCleanerId: null, priorVisits: 0 },
      }),
      [sarah()],
      { now: NOW, hoursUntilJob: 200 },
    );
    expect(result.held).toBe(true);
    if (!result.held) return;
    expect(result.expiresAt.getTime()).toBe(NOW.getTime() + HOLD_CAPS.relaxed * 1000);
  });
});

describe("what continuity costs", () => {
  it("is the difference against the cheapest alternative", () => {
    expect(holdCostCents(5750, 4200)).toBe(1550);
  });

  it("goes negative when the incumbent was the cheapest option anyway", () => {
    // Not clamped to zero: "keeping her SAVED us $12" is a real finding and
    // a floor at zero would erase every instance of it.
    expect(holdCostCents(4000, 5200)).toBe(-1200);
  });

  it("is unknown, not free, when there is no alternative at all", () => {
    expect(holdCostCents(5750, null)).toBeNull();
  });

  it("applies no ceiling by default — continuity is not given up on price", () => {
    // The cap shipped at 15% of the ticket and fired constantly, because the
    // comparison that matters is against an idle W-2 costing nothing and a
    // contractor's whole payout is 33-36% of the ticket. The rule it produced
    // was "a customer loses their cleaner whenever Shonda has a spare hour".
    expect(continuityPremiumCapCents(20000)).toBeNull();
    expect(continuityPremiumCapCents(0)).toBeNull();
  });
});

describe("shonda is a W-2 and holds work differently", () => {
  it("still resolves as the incumbent — the engine decides what to do with it", () => {
    const result = resolveContinuity(
      job({
        continuity: { preferredCleanerId: "shonda", incumbentCleanerId: null, priorVisits: 4 },
      }),
      [shonda(), contractor()],
      { now: NOW, hoursUntilJob: 200 },
    );
    expect(result.held).toBe(true);
    if (!result.held) return;
    expect(result.cleaner.type).toBe("w2_core");
  });
});
