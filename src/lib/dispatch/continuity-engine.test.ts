/**
 * Step 0 of the engine: the incumbent's first refusal.
 *
 * These assert the product promise rather than the arithmetic — that the
 * cleaner a customer already has is not made to compete for that customer's
 * own house, and that the cost engine below still gets its turn everywhere a
 * relationship does not exist.
 */
import { describe, expect, it } from "vitest";
import { dispatch, dispatchBoard } from "./engine";
import { MIN_VISITS_FOR_INCUMBENCY } from "./continuity";
import { contractor, shonda } from "./fixtures";
import { constantEstimator } from "./route";
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
    scheduledStart: new Date("2026-09-10T15:00:00Z"), // 9 days out
    ...overrides,
  };
}

function context(cleaners: Cleaner[], driveMinutes = 20, driveMiles = 12) {
  const estimate = constantEstimator(driveMinutes, driveMiles);
  return {
    now: NOW,
    cleaners,
    driveFor: (c: Cleaner, j: DispatchJob) => estimate(c.lastStopZip ?? "75034", j.zip),
    rng: () => 0.5,
  };
}

const sarah = (overrides: Partial<Cleaner> = {}) =>
  contractor({ id: "sarah", name: "Sarah", ...overrides });

const asked = (priorVisits = 0) => ({
  preferredCleanerId: "sarah",
  incumbentCleanerId: null,
  priorVisits,
});

describe("a requested cleaner is not made to bid for her own customer", () => {
  it("holds the job for her instead of posting it to the board", () => {
    const decision = dispatch(
      job({ continuity: asked() }),
      context([sarah(), contractor({ id: "stranger" })]),
    );

    expect(decision.kind).toBe("hold_for_incumbent");
    if (decision.kind !== "hold_for_incumbent") return;
    expect(decision.cleaner.id).toBe("sarah");
    expect(decision.basis).toBe("preferred");
    expect(decision.exclusiveUntil.getTime()).toBeGreaterThan(NOW.getTime());
    expect(decision.fallback).toBe("open_board");
  });

  it("keeps her even when an idle W-2 would cost nothing at all", () => {
    // The whole point. Shonda is inside her guarantee, so this job adds
    // nothing to payroll and the cost engine would take it every time. The
    // customer asked for Sarah, so the customer gets Sarah.
    const decision = dispatch(
      job({ continuity: asked() }),
      context([sarah(), shonda({ hoursScheduledThisWeek: 0 })]),
    );

    expect(decision.kind).toBe("hold_for_incumbent");
    if (decision.kind !== "hold_for_incumbent") return;
    expect(decision.cleaner.id).toBe("sarah");

    // And the cost of that choice is written down rather than hidden.
    expect(decision.continuity.status).toBe("held");
    if (decision.continuity.status !== "held") return;
    expect(decision.continuity.premiumCents).toBe(decision.payoutCents);
  });

  it("offers rather than assigns, because she is not an employee", () => {
    const decision = dispatch(job({ continuity: asked() }), context([sarah()]));
    // A contractor a platform can schedule without asking is an employee with
    // extra steps. She gets an offer and a countdown.
    expect(decision.kind).toBe("hold_for_incumbent");
  });

  it("assigns rather than offers when the incumbent is a W-2", () => {
    const decision = dispatch(
      job({
        continuity: { preferredCleanerId: "shonda", incumbentCleanerId: null, priorVisits: 6 },
      }),
      context([shonda({ hoursScheduledThisWeek: 10 }), contractor()]),
    );

    expect(decision.kind).toBe("assign_guaranteed");
    if (decision.kind !== "assign_guaranteed") return;
    expect(decision.cleaner.id).toBe("shonda");
    expect(decision.continuity.status).toBe("assigned");
  });
});

describe("an incumbency nobody asked for is still an incumbency", () => {
  const revealed = {
    preferredCleanerId: null,
    incumbentCleanerId: "sarah",
    priorVisits: MIN_VISITS_FOR_INCUMBENCY + 3,
  };

  it("holds for her against another contractor", () => {
    const decision = dispatch(
      job({ continuity: revealed }),
      context([sarah(), contractor({ id: "stranger" })]),
    );
    expect(decision.kind).toBe("hold_for_incumbent");
    if (decision.kind !== "hold_for_incumbent") return;
    expect(decision.basis).toBe("incumbent");
  });

  it("holds for her even when an idle W-2 would cost nothing", () => {
    // THE POLICY. A cleaner who has been to a house before keeps going to that
    // house. Payroll having a gap this week is not a reason to send somebody
    // else, and under the old 15% cap this exact case reassigned the customer
    // every time.
    const decision = dispatch(
      job({ continuity: revealed }),
      context([sarah(), shonda({ hoursScheduledThisWeek: 0 })]),
    );

    expect(decision.kind).toBe("hold_for_incumbent");
    if (decision.kind !== "hold_for_incumbent") return;
    expect(decision.cleaner.id).toBe("sarah");
  });

  it("still records what that choice cost", () => {
    // Not waived, but not invisible either: the spread agreed when a pairing
    // forms is the spread for as long as it lasts, so the number has to be
    // readable even though it reassigns nobody.
    const decision = dispatch(
      job({ continuity: revealed }),
      context([sarah(), shonda({ hoursScheduledThisWeek: 0 })]),
    );

    expect(decision.continuity.status).toBe("held");
    if (decision.continuity.status !== "held") return;
    expect(decision.continuity.premiumCents).toBeGreaterThan(0);
  });

  it("gives the job up only when a ceiling is set deliberately", () => {
    // The cap survives as a manual safety valve. It is off by default and
    // nothing reaches this branch unless somebody turns it on.
    const decision = dispatch(job({ continuity: revealed }), {
      ...context([sarah(), shonda({ hoursScheduledThisWeek: 0 })]),
      continuityPremiumCapCents: 100,
    });

    expect(decision.continuity.status).toBe("waived_too_costly");
  });
});

describe("everything without a relationship behaves exactly as it did", () => {
  it("still spends guaranteed hours first on a fresh job", () => {
    const decision = dispatch(job(), context([shonda({ hoursScheduledThisWeek: 20 }), contractor()]));
    expect(decision.kind).toBe("assign_guaranteed");
    expect(decision.continuity.status).toBe("none");
    if (decision.continuity.status !== "none") return;
    expect(decision.continuity.reason).toBe("no_relationship");
  });

  it("still posts a fresh job to the open board", () => {
    const decision = dispatch(job(), context([contractor()]));
    expect(decision.kind).toBe("open_board");
  });

  it("drops the hold entirely on a same-day backfill", () => {
    const decision = dispatch(
      job({
        continuity: asked(),
        scheduledStart: new Date(NOW.getTime() + 2 * 3_600_000),
      }),
      context([sarah(), contractor({ id: "stranger" })]),
    );

    // Two hours out. A house that needs cleaning this afternoon is not served
    // by waiting politely for one person to answer.
    expect(decision.kind).toBe("waterfall");
    expect(decision.continuity.status).toBe("none");
    if (decision.continuity.status !== "none") return;
    expect(decision.continuity.reason).toBe("no_lead_time");
  });

  it("reports a lapsed incumbent rather than silently rematching", () => {
    const decision = dispatch(
      job({ continuity: asked() }),
      context([sarah({ backgroundCheckCleared: false }), contractor({ id: "stranger" })]),
    );

    expect(decision.kind).toBe("open_board");
    expect(decision.continuity.status).toBe("none");
    if (decision.continuity.status !== "none") return;
    // The signal a manager needs: this customer is about to meet a stranger,
    // and the reason is a cleaner who has lapsed a requirement.
    expect(decision.continuity.reason).toBe("incumbent_ineligible");
  });

  it("leaves the incumbent in the ranked pool after a hold is waived", () => {
    // She must still be reachable by the ladder. A cleaner excluded from the
    // auction for having been too expensive to hold learns nothing useful,
    // and the customer loses her over a margin she was never asked about.
    //
    // The cap is forced negative to isolate the branch: with only contractors
    // in the market the premium is exactly zero, which no honest cap waives.
    const decision = dispatch(
      job({
        continuity: {
          preferredCleanerId: null,
          incumbentCleanerId: "sarah",
          priorVisits: 9,
        },
      }),
      { ...context([sarah(), contractor({ id: "stranger" })]), continuityPremiumCapCents: -1 },
    );

    expect(decision.continuity.status).toBe("waived_too_costly");
    expect(decision.kind).toBe("open_board");
    if (decision.kind !== "open_board") return;
    expect(decision.eligible.map((c) => c.id)).toContain("sarah");
  });
});

describe("a cleaner is not asked a question she has already answered", () => {
  it("stops holding the job for an incumbent who passed at this rate", () => {
    // Without this the hourly sweep re-offers a declined visit to the same
    // cleaner every hour until it happens, and keeps it off the board while
    // she does not answer.
    const decision = dispatch(
      job({
        continuity: asked(),
        passedOver: [{ cleanerId: "sarah", hourlyRateCents: 2500 }],
      }),
      context([sarah(), contractor({ id: "stranger" })]),
    );

    expect(decision.kind).toBe("open_board");
    expect(decision.continuity.status).toBe("none");
    if (decision.continuity.status !== "none") return;
    expect(decision.continuity.reason).toBe("incumbent_passed");
  });

  it("keeps her out of the pool at that rate too", () => {
    const decision = dispatch(
      job({
        continuity: asked(),
        passedOver: [{ cleanerId: "sarah", hourlyRateCents: 2500 }],
      }),
      context([sarah(), contractor({ id: "stranger" })]),
    );

    if (decision.kind !== "open_board") return;
    expect(decision.eligible.map((c) => c.id)).not.toContain("sarah");
    expect(decision.eligible.map((c) => c.id)).toContain("stranger");
  });

  it("treats passing at a higher rate as settling the lower one", () => {
    // Refusing $30/h obviously answers $25/h as well, and re-asking downward
    // is the fastest way to teach a cleaner that answering means nothing.
    const decision = dispatch(
      job({ continuity: asked(), passedOver: [{ cleanerId: "sarah", hourlyRateCents: 3000 }] }),
      context([sarah(), contractor({ id: "stranger" })]),
    );
    expect(decision.kind).toBe("open_board");
    if (decision.kind !== "open_board") return;
    expect(decision.eligible.map((c) => c.id)).not.toContain("sarah");
  });

  it("still reaches her at a rate she has not passed on", () => {
    // The ladder's entire mechanism. An incumbent who declined the opening
    // rate must stay reachable higher up, or she watches a stranger take her
    // own customer at a rate she was never offered.
    const decision = dispatch(
      job({ continuity: asked(), passedOver: [{ cleanerId: "sarah", hourlyRateCents: 2400 }] }),
      context([sarah(), contractor({ id: "stranger" })]),
    );
    expect(decision.kind).toBe("hold_for_incumbent");
  });

  it("lets an UNANSWERED hold lapse to the board instead of renewing it", () => {
    // The failure this is really guarding. A hold that expires unanswered
    // looks identical to a fresh job to a stateless engine, so the next sweep
    // would hold it for her again — and the one after that. The visit would
    // never reach the open board at all, and a hold that cannot lapse is not
    // a hold.
    const decision = dispatch(
      job({
        continuity: asked(),
        passedOver: [{ cleanerId: "sarah", hourlyRateCents: 2500 }],
      }),
      context([sarah(), contractor({ id: "stranger" })]),
    );

    expect(decision.kind).toBe("open_board");
    if (decision.kind !== "open_board") return;
    expect(decision.eligible.map((c) => c.id)).toEqual(["stranger"]);
  });

  it("does not confuse one cleaner's answer with another's", () => {
    const decision = dispatch(
      job({ continuity: asked(), passedOver: [{ cleanerId: "stranger", hourlyRateCents: 2500 }] }),
      context([sarah(), contractor({ id: "stranger" })]),
    );
    expect(decision.kind).toBe("hold_for_incumbent");
  });
});

describe("planning a whole board", () => {
  it("consumes the incumbent's capacity as it holds her, not after", () => {
    // Two visits for one customer whose cleaner is Shonda. Deciding each in
    // isolation would tell BOTH of them she has three guaranteed hours left,
    // and the second would come out free when it is not.
    const asksForShonda = {
      preferredCleanerId: "shonda",
      incumbentCleanerId: null,
      priorVisits: 8,
    };

    const entries = dispatchBoard(
      [
        job({ id: "a", continuity: asksForShonda }),
        job({
          id: "b",
          continuity: asksForShonda,
          scheduledStart: new Date("2026-09-11T15:00:00Z"),
        }),
      ],
      context([shonda({ hoursScheduledThisWeek: 37 }), contractor({ id: "stranger" })]),
    );

    // She keeps both, because the customer asked for her. But only the first
    // is free: the board consumed her guarantee as it planned it, so the
    // second is correctly priced as costing something.
    expect(entries.map((e) => e.decision.kind)).toEqual(["assign_guaranteed", "assign_w2"]);

    const second = entries[1];
    expect(second).toBeDefined();
    if (!second) return;
    expect(second.decision.continuity.status).toBe("assigned");
    if (second.decision.continuity.status !== "assigned") return;
    // And what continuity cost on that second visit is a real, positive number
    // somebody can read back.
    expect(second.decision.continuity.premiumCents).toBeGreaterThan(0);
  });
});

describe("the ladder is a schedule across sweeps, not a broadcast", () => {
  const urgent = () => new Date(NOW.getTime() + 12 * 3_600_000);

  it("opens at the opening rate when nothing has been offered yet", () => {
    const decision = dispatch(
      job({ scheduledStart: urgent() }),
      context([contractor(), contractor({ id: "b" }), contractor({ id: "c" })]),
    );
    expect(decision.kind).toBe("waterfall");
    if (decision.kind !== "waterfall") return;
    expect(decision.ladder[0]?.hourlyRateCents).toBe(2500);
  });

  it("starts above whatever the job has already been offered at", () => {
    // Without this the engine rebuilds from the opening rate every hour and
    // sends the same rung for ever — a job nobody wants at $25/h is offered
    // at $25/h until it happens, and the escalation the ladder exists for
    // never occurs.
    const decision = dispatch(
      job({ scheduledStart: urgent(), offeredUpToCents: 2700 }),
      context([contractor(), contractor({ id: "b" })]),
    );

    expect(decision.kind).toBe("waterfall");
    if (decision.kind !== "waterfall") return;
    expect(decision.ladder[0]?.hourlyRateCents).toBeGreaterThan(2700);
  });

  it("reaches a cleaner again at a rate above the one she passed on", () => {
    // The ladder's whole mechanism. She said no at $25/h; $28/h is a
    // different question and she is entitled to be asked it.
    const decision = dispatch(
      job({
        scheduledStart: urgent(),
        offeredUpToCents: 2700,
        passedOver: [{ cleanerId: "sarah", hourlyRateCents: 2500 }],
      }),
      context([sarah(), contractor({ id: "b" })]),
    );

    if (decision.kind !== "waterfall") return;
    expect(decision.tiers.flat().map((c) => c.id)).toContain("sarah");
  });

  it("falls back to the cheapest W-2 once the ladder is spent", () => {
    // Past the ceiling, sending our own employee is cheaper than buying the
    // labour. That is the entire reason the ceiling is a marginal cost rather
    // than a percentage.
    const decision = dispatch(
      job({ scheduledStart: urgent(), offeredUpToCents: 100_000 }),
      context([contractor(), shonda({ hoursScheduledThisWeek: 39 })]),
    );

    expect(decision.kind).toBe("assign_w2");
    if (decision.kind !== "assign_w2") return;
    expect(decision.cleaner.id).toBe("shonda");
  });

  it("says a spent ladder with no fallback needs a person", () => {
    const decision = dispatch(
      job({ scheduledStart: urgent(), offeredUpToCents: 100_000 }),
      context([contractor()]),
    );
    expect(decision.kind).toBe("no_eligible_cleaner");
  });
});

describe("the spread is fixed at the rate the relationship was agreed at", () => {
  const agreedAt = (rate: number | null) => ({
    preferredCleanerId: "sarah",
    incumbentCleanerId: "sarah",
    priorVisits: 20,
    agreedPayoutRateCents: rate,
  });

  it("offers the incumbent her agreed rate, not the current opening rate", () => {
    // A pairing that works lasts years, so the margin agreed when it formed is
    // the margin for years. Pricing her from the global opening rate means a
    // rate raised to attract NEW supply silently re-cuts the margin on every
    // EXISTING customer — the same bug 0014 fixed on the customer's side,
    // pointing the other way.
    const decision = dispatch(
      job({ continuity: agreedAt(2800) }),
      context([sarah(), contractor({ id: "stranger" })]),
    );

    expect(decision.kind).toBe("hold_for_incumbent");
    if (decision.kind !== "hold_for_incumbent") return;
    expect(decision.hourlyRateCents).toBe(2800);
    // 138 minutes at $28/h.
    expect(decision.payoutCents).toBe(6440);
  });

  it("honours an agreed rate BELOW the current opening rate too", () => {
    // The direction that actually protects margin. A relationship agreed at
    // $24/h stays at $24/h when the opening rate moves to $25 — otherwise
    // every existing customer's spread narrows the moment the market rate
    // moves, which is the whole thing this locks.
    const decision = dispatch(
      job({ continuity: agreedAt(2400) }),
      context([sarah(), contractor({ id: "stranger" })]),
    );

    if (decision.kind !== "hold_for_incumbent") return;
    expect(decision.hourlyRateCents).toBe(2400);
  });

  it("falls back to the opening rate for a pairing with no agreed rate", () => {
    // Null means unlocked, not free — the honest reading for every
    // relationship that predates the column.
    const decision = dispatch(
      job({ continuity: agreedAt(null) }),
      context([sarah(), contractor({ id: "stranger" })]),
    );

    if (decision.kind !== "hold_for_incumbent") return;
    expect(decision.hourlyRateCents).toBe(2500);
  });

  it("prices the continuity premium at the agreed rate as well", () => {
    // Or the recorded cost of keeping her would be measured against a rate
    // she is not actually being paid.
    const cheap = dispatch(
      job({ continuity: agreedAt(2400) }),
      context([sarah(), shonda({ hoursScheduledThisWeek: 0 })]),
    );
    const dear = dispatch(
      job({ continuity: agreedAt(3200) }),
      context([sarah(), shonda({ hoursScheduledThisWeek: 0 })]),
    );

    if (cheap.continuity.status !== "held" || dear.continuity.status !== "held") return;
    expect(dear.continuity.premiumCents).toBeGreaterThan(cheap.continuity.premiumCents ?? 0);
  });
});
