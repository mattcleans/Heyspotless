import { describe, expect, it } from "vitest";
import {
  DEFAULT_LADDER,
  ESCALATION_ALARM_THRESHOLD,
  MAX_RATE_CENTS_PER_HOUR,
  OPENING_RATE_CENTS_PER_HOUR,
  assignTiers,
  buildLadder,
  ceilingRateFromW2Cost,
  escalationRate,
  payoutForRate,
  presentOffer,
  rankScore,
} from "./ladder";
import { buildQuote } from "../pricing/quote";
import type { DispatchJob } from "./types";

/** Deterministic RNG so ladder shape is reproducible in tests. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function jobFrom(service: "standard" | "deep" | "move_in_out", freq: "one_time" | "weekly" | "biweekly" | "monthly", beds: number, baths: number): DispatchJob {
  const q = buildQuote(service, freq, { bedrooms: beds, bathrooms: baths });
  return {
    id: `${service}-${freq}-${beds}x${baths}`,
    priceCents: q.totalCents,
    estimatedCleanMinutes: q.estimatedMinutes,
    zip: "75024",
    scheduledStart: null,
  };
}

describe("the flat-percentage problem the ladder replaces (plan section 04)", () => {
  /**
   * A flat 35% buys wildly different hourly rates, and it points the wrong way:
   * the worst-paid jobs are the weekly recurring customers — the relationships
   * that most need to fill every week.
   */
  const rows = [
    { label: "Weekly 2bd/2ba",        job: jobFrom("standard", "weekly", 2, 2),      price: 16000, hours: 2.3,  payout: 5600,  perHour: 2435 },
    { label: "Bi-weekly 2bd/2ba",     job: jobFrom("standard", "biweekly", 2, 2),    price: 17000, hours: 2.3,  payout: 5950,  perHour: 2587 },
    { label: "Deep clean 3bd/2ba",    job: jobFrom("deep", "one_time", 3, 2),        price: 36200, hours: 4.82, payout: 12670, perHour: 2630 },
    { label: "Move-out 4bd/4ba",      job: jobFrom("move_in_out", "one_time", 4, 4), price: 57600, hours: 8.05, payout: 20160, perHour: 2504 },
    { label: "One-time std 3bd/2ba",  job: jobFrom("standard", "one_time", 3, 2),    price: 21900, hours: 2.55, payout: 7665,  perHour: 3006 },
  ];

  for (const row of rows) {
    it(`${row.label}: 35% = $${(row.payout / 100).toFixed(2)} = $${(row.perHour / 100).toFixed(2)}/hr`, () => {
      expect(row.job.priceCents).toBe(row.price);
      expect(row.job.estimatedCleanMinutes / 60).toBeCloseTo(row.hours, 2);

      const flat = Math.round(row.price * 0.35);
      expect(flat).toBe(row.payout);

      const perHour = flat / (row.job.estimatedCleanMinutes / 60);
      expect(perHour).toBeCloseTo(row.perHour, 0);
    });
  }

  it("is a 23% spread on an identical percentage", () => {
    const perHour = rows.map((r) => (r.price * 0.35) / (r.job.estimatedCleanMinutes / 60));
    const spread = Math.max(...perHour) / Math.min(...perHour) - 1;
    expect(spread).toBeCloseTo(0.23, 2);
  });

  it("penalises weekly recurring work worst — exactly the wrong jobs to underpay", () => {
    const perHour = (r: (typeof rows)[number]) => (r.price * 0.35) / (r.job.estimatedCleanMinutes / 60);
    const weekly = rows.find((r) => r.label === "Weekly 2bd/2ba")!;
    expect(perHour(weekly)).toBe(Math.min(...rows.map(perHour)));
  });

  it("pricing per hour instead removes the spread entirely", () => {
    const perHour = rows.map(
      (r) => payoutForRate(OPENING_RATE_CENTS_PER_HOUR, r.job.estimatedCleanMinutes) /
             (r.job.estimatedCleanMinutes / 60),
    );
    const spread = Math.max(...perHour) / Math.min(...perHour) - 1;
    expect(spread).toBeLessThan(0.01);
  });
});

describe("offers denominated in dollars per hour", () => {
  it("a weekly 2bd/2ba opens at $57.50 — about 36% of the ticket", () => {
    const job = jobFrom("standard", "weekly", 2, 2);
    const payout = payoutForRate(OPENING_RATE_CENTS_PER_HOUR, job.estimatedCleanMinutes);
    expect(payout).toBe(5750);
    expect(payout / job.priceCents).toBeCloseTo(0.36, 2);
  });

  it("a one-time 3bd/2ba opens at the same rate — about 29% of the ticket", () => {
    const job = jobFrom("standard", "one_time", 3, 2);
    const payout = payoutForRate(OPENING_RATE_CENTS_PER_HOUR, job.estimatedCleanMinutes);
    expect(payout).toBe(6375);
    expect(payout / job.priceCents).toBeCloseTo(0.29, 2);
  });
});

describe("the ladder", () => {
  const job = jobFrom("standard", "biweekly", 2, 2);

  it("opens at the base rate and climbs", () => {
    const ladder = buildLadder(job, { rng: seeded(1) });
    expect(ladder[0]!.hourlyRateCents).toBe(OPENING_RATE_CENTS_PER_HOUR);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]!.hourlyRateCents).toBeGreaterThan(ladder[i - 1]!.hourlyRateCents);
      expect(ladder[i]!.offerAtSeconds).toBeGreaterThan(ladder[i - 1]!.offerAtSeconds);
    }
  });

  it("never exceeds the aspirational ceiling", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const ladder = buildLadder(job, { rng: seeded(seed) });
      for (const rung of ladder) {
        expect(rung.hourlyRateCents).toBeLessThanOrEqual(MAX_RATE_CENTS_PER_HOUR);
      }
    }
  });

  it("is capped by the cheapest W-2 option, which is usually tighter", () => {
    // Iggy at a 20-minute drive: $72.71 for a 2.3h job.
    const ladder = buildLadder(job, { w2CeilingCents: 7271, rng: seeded(7) });
    const ceilingRate = ceilingRateFromW2Cost(7271, job.estimatedCleanMinutes);
    expect(ceilingRate).toBeLessThan(MAX_RATE_CENTS_PER_HOUR);
    for (const rung of ladder) {
      expect(rung.hourlyRateCents).toBeLessThanOrEqual(ceilingRate);
    }
  });

  it("holds the ceiling near 43% of a $170 ticket, not the 50% originally picked", () => {
    const ceilingRate = ceilingRateFromW2Cost(7271, job.estimatedCleanMinutes);
    const topPayout = payoutForRate(ceilingRate, job.estimatedCleanMinutes);
    expect(topPayout / job.priceCents).toBeGreaterThan(0.42);
    expect(topPayout / job.priceCents).toBeLessThan(0.44);
  });

  it("randomises step size and dwell so the pattern cannot be learned", () => {
    const a = buildLadder(job, { rng: seeded(11) });
    const b = buildLadder(job, { rng: seeded(99) });
    const shape = (l: typeof a) => l.map((r) => `${r.hourlyRateCents}:${r.dwellSeconds}`).join("|");
    expect(shape(a)).not.toBe(shape(b));
  });

  it("always emits an opening rung even when the W-2 option is already cheaper", () => {
    // A very cheap W-2 fallback: the auction should not run, but the caller
    // decides that — the builder still returns something coherent.
    const ladder = buildLadder(job, { w2CeilingCents: 100, rng: seeded(3) });
    expect(ladder).toHaveLength(1);
    expect(ladder[0]!.hourlyRateCents).toBe(OPENING_RATE_CENTS_PER_HOUR);
  });

  it("terminates for every seed", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const ladder = buildLadder(job, { rng: seeded(seed) });
      expect(ladder.length).toBeGreaterThan(0);
      expect(ladder.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("what the cleaner is shown", () => {
  it("carries the payout and duration, and nothing about escalation", () => {
    const job = jobFrom("standard", "weekly", 2, 2);
    const ladder = buildLadder(job, { rng: seeded(5) });
    const start = new Date("2026-09-01T14:00:00Z");
    const offer = presentOffer(job, ladder[0]!, start);

    expect(offer.payoutCents).toBe(5750);
    expect(offer.estimatedMinutes).toBe(138);
    expect(offer.expiresAt.getTime()).toBeGreaterThan(start.getTime());

    // The presented offer must not leak the ladder: no rung index, no ceiling,
    // no next rate. A visible ladder teaches cleaners to decline and wait.
    expect(Object.keys(offer).sort()).toEqual(
      ["estimatedMinutes", "expiresAt", "jobId", "payoutCents"].sort(),
    );
  });
});

describe("escalation rate KPI", () => {
  it("is zero when everything clears at the base rate", () => {
    const accepted = Array.from({ length: 10 }, () => ({ hourlyRateCents: 2500 }));
    expect(escalationRate(accepted)).toBe(0);
  });

  it("flags a base rate below market", () => {
    const accepted = [
      ...Array.from({ length: 6 }, () => ({ hourlyRateCents: 2500 })),
      ...Array.from({ length: 4 }, () => ({ hourlyRateCents: 2900 })),
    ];
    expect(escalationRate(accepted)).toBeCloseTo(0.4, 5);
    expect(escalationRate(accepted)).toBeGreaterThan(ESCALATION_ALARM_THRESHOLD);
  });

  it("is zero, not NaN, with no data", () => {
    expect(escalationRate([])).toBe(0);
  });
});

describe("tier ranking", () => {
  it("rewards acceptance rate — declining costs future volume", () => {
    const base = { rating: 4.5, driveMinutes: 20, priorJobsForCustomer: 0 };
    const eager = rankScore({ ...base, acceptanceRate: 0.9 });
    const holdout = rankScore({ ...base, acceptanceRate: 0.3 });
    expect(eager).toBeGreaterThan(holdout);
  });

  it("rewards proximity and prior history with the customer", () => {
    const base = { rating: 4.5, acceptanceRate: 0.8, priorJobsForCustomer: 0 };
    expect(rankScore({ ...base, driveMinutes: 5 })).toBeGreaterThan(
      rankScore({ ...base, driveMinutes: 45 }),
    );
    expect(
      rankScore({ ...base, driveMinutes: 20, priorJobsForCustomer: 4 }),
    ).toBeGreaterThan(rankScore({ ...base, driveMinutes: 20 }));
  });

  it("splits candidates into tiers", () => {
    expect(assignTiers([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(assignTiers([], 3)).toEqual([]);
  });
});

describe("default configuration", () => {
  it("opens at $25/hr and aspires to $32/hr", () => {
    expect(DEFAULT_LADDER.openingRateCents).toBe(2500);
    expect(DEFAULT_LADDER.maxRateCents).toBe(3200);
  });
});
