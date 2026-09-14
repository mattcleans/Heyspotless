import { describe, expect, it } from "vitest";
import {
  DEFAULT_LADDER,
  ESCALATION_ALARM_THRESHOLD,
  assignTiers,
  buildLadder,
  escalationRate,
  presentOffer,
  rankScore,
} from "./ladder";
import {
  CLEANER_SHARE_OF_TICKET,
  MAX_SHARE_OF_TICKET,
  ceilingShareFromW2Cost,
  payoutForTicket,
} from "../pricing/payout";
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

describe("what a share of the ticket costs, on the record", () => {
  /**
   * The plan originally rejected a flat share for exactly this: it buys wildly
   * different hourly rates, and it points the wrong way — the worst-paid jobs
   * are the weekly recurring customers, the relationships that most need to
   * fill every week.
   *
   * The policy (Matt, 14 September 2026) accepts that cost deliberately, for
   * the reasons in lib/pricing/payout.ts. These stay as tests rather than
   * being deleted, because the cost is real and it is the thing to watch: if
   * new recurring customers start going unfilled, this block is the
   * explanation, and MINIMUM_PAYOUT_CENTS is the lever.
   */
  const rows = [
    { label: "Weekly 2bd/2ba",        job: jobFrom("standard", "weekly", 2, 2) },
    { label: "Bi-weekly 2bd/2ba",     job: jobFrom("standard", "biweekly", 2, 2) },
    { label: "Deep clean 3bd/2ba",    job: jobFrom("deep", "one_time", 3, 2) },
    { label: "Move-out 4bd/4ba",      job: jobFrom("move_in_out", "one_time", 4, 4) },
    { label: "One-time std 3bd/2ba",  job: jobFrom("standard", "one_time", 3, 2) },
  ];

  const perHour = (job: DispatchJob) =>
    payoutForTicket(job.priceCents, CLEANER_SHARE_OF_TICKET) /
    (job.estimatedCleanMinutes / 60);

  it("buys a materially different hourly rate on every job", () => {
    const rates = rows.map((r) => perHour(r.job));
    const spread = Math.max(...rates) / Math.min(...rates) - 1;
    expect(spread).toBeGreaterThan(0.2);
  });

  it("pays worst on the weekly recurring job — the one that must fill", () => {
    // The known cost, asserted so it cannot quietly get worse. It is
    // survivable because dispatch is no longer an open board for established
    // customers: a recurring visit goes to its incumbent exclusively first.
    // The exposure that remains is a NEW recurring customer, who has no
    // incumbent.
    const weekly = rows.find((r) => r.label === "Weekly 2bd/2ba")!;
    expect(perHour(weekly.job)).toBe(Math.min(...rows.map((r) => perHour(r.job))));
  });

  it("moves the cleaner's fee with a discount to the customer", () => {
    // The whole point of the model. Same house, same work; only our price
    // differs, and her fee follows it.
    const weekly = jobFrom("standard", "weekly", 2, 2);
    const oneTime = jobFrom("standard", "one_time", 2, 2);

    expect(weekly.estimatedCleanMinutes).toBe(oneTime.estimatedCleanMinutes);
    expect(weekly.priceCents).toBeLessThan(oneTime.priceCents);

    const weeklyPay = payoutForTicket(weekly.priceCents, CLEANER_SHARE_OF_TICKET);
    const oneTimePay = payoutForTicket(oneTime.priceCents, CLEANER_SHARE_OF_TICKET);
    expect(weeklyPay).toBeLessThan(oneTimePay);
    expect(weeklyPay / weekly.priceCents).toBeCloseTo(oneTimePay / oneTime.priceCents, 5);
  });
});

describe("offers denominated as a share of the ticket", () => {
  it("a weekly 2bd/2ba pays $52.80 — 33% of a $160 ticket", () => {
    const job = jobFrom("standard", "weekly", 2, 2);
    const payout = payoutForTicket(job.priceCents, CLEANER_SHARE_OF_TICKET);
    expect(payout).toBe(5280);
    expect(payout / job.priceCents).toBeCloseTo(0.33, 5);
  });

  it("a one-time 3bd/2ba pays $72.27 — the same 33% of a bigger ticket", () => {
    const job = jobFrom("standard", "one_time", 3, 2);
    const payout = payoutForTicket(job.priceCents, CLEANER_SHARE_OF_TICKET);
    expect(payout).toBe(7227);
    expect(payout / job.priceCents).toBeCloseTo(0.33, 5);
  });
});

describe("the ladder", () => {
  const job = jobFrom("standard", "biweekly", 2, 2);

  it("opens at the standard share and climbs", () => {
    const ladder = buildLadder(job, { rng: seeded(1) });
    expect(ladder[0]!.share).toBe(CLEANER_SHARE_OF_TICKET);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]!.share).toBeGreaterThan(ladder[i - 1]!.share);
      expect(ladder[i]!.payoutCents).toBeGreaterThan(ladder[i - 1]!.payoutCents);
      expect(ladder[i]!.offerAtSeconds).toBeGreaterThan(ladder[i - 1]!.offerAtSeconds);
    }
  });

  it("never exceeds the aspirational ceiling", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const ladder = buildLadder(job, { rng: seeded(seed) });
      for (const rung of ladder) {
        expect(rung.share).toBeLessThanOrEqual(MAX_SHARE_OF_TICKET);
      }
    }
  });

  it("is capped by the cheapest W-2 option, which is usually tighter", () => {
    // Iggy at a 20-minute drive: $72.71 for this job.
    const ladder = buildLadder(job, { w2CeilingCents: 7271, rng: seeded(7) });
    const ceilingShare = ceilingShareFromW2Cost(7271, job.priceCents);
    expect(ceilingShare).toBeLessThan(MAX_SHARE_OF_TICKET);
    for (const rung of ladder) {
      expect(rung.share).toBeLessThanOrEqual(ceilingShare);
    }
  });

  it("holds the ceiling near 43% of a $170 ticket, not the 50% aspirational cap", () => {
    // The cap that actually binds is a cost, not a percentage: past it, our
    // own employee is cheaper than buying the labour.
    const ceilingShare = ceilingShareFromW2Cost(7271, job.priceCents);
    expect(ceilingShare).toBeGreaterThan(0.42);
    expect(ceilingShare).toBeLessThan(0.44);
  });

  it("randomises step size and dwell so the pattern cannot be learned", () => {
    const a = buildLadder(job, { rng: seeded(11) });
    const b = buildLadder(job, { rng: seeded(99) });
    const shape = (l: typeof a) => l.map((r) => `${r.share}:${r.dwellSeconds}`).join("|");
    expect(shape(a)).not.toBe(shape(b));
  });

  it("always emits an opening rung even when the W-2 option is already cheaper", () => {
    // A very cheap W-2 fallback: the auction should not run, but the caller
    // decides that — the builder still returns something coherent.
    const ladder = buildLadder(job, { w2CeilingCents: 100, rng: seeded(3) });
    expect(ladder).toHaveLength(1);
    expect(ladder[0]!.share).toBe(CLEANER_SHARE_OF_TICKET);
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

    // 33% of a $160.00 weekly ticket.
    expect(offer.payoutCents).toBe(5280);
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
    const accepted = Array.from({ length: 10 }, () => ({ share: 0.33 }));
    expect(escalationRate(accepted)).toBe(0);
  });

  it("flags a base rate below market", () => {
    const accepted = [
      ...Array.from({ length: 6 }, () => ({ share: 0.33 })),
      ...Array.from({ length: 4 }, () => ({ share: 0.38 })),
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
  it("opens at 33% of the ticket and aspires to 49%", () => {
    expect(DEFAULT_LADDER.openingShare).toBe(0.33);
    expect(DEFAULT_LADDER.maxShare).toBe(0.49);
  });
});
