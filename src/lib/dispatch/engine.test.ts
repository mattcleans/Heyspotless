import { matchingWeek } from "./week";
import { describe, expect, it } from "vitest";
import {
  URGENT_THRESHOLD_HOURS,
  dispatch,
  dispatchBoard,
  isUrgent,
  residualGuaranteedHours,
} from "./engine";
import { contractor, iggy, shonda } from "./fixtures";
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
    scheduledStart: new Date("2026-09-10T15:00:00Z"), // 9 days out — not urgent
    ...overrides,
  };
}

function context(cleaners: Cleaner[], driveMinutes = 20, driveMiles = 12) {
  const estimate = constantEstimator(driveMinutes, driveMiles);
  return {
    now: NOW,
    cleaners,
    // These money fixtures deliberately provide the saved load for their appointment week.
    scheduledHoursFor: (cleaner: Cleaner) => cleaner.hoursScheduledThisWeek,
    driveFor: (c: Cleaner, j: DispatchJob) => estimate(c.lastStopZip ?? "75034", j.zip),
    rng: () => 0.5,
  };
}

describe("step 1 — guaranteed hours are spent first", () => {
  it("assigns to a W-2 cleaner inside their guarantee at zero marginal cost", () => {
    const decision = dispatch(job(), context([shonda({ hoursScheduledThisWeek: 20 }), contractor()]));
    expect(decision.kind).toBe("assign_guaranteed");
    if (decision.kind !== "assign_guaranteed") return;
    expect(decision.cleaner.id).toBe("shonda");
    expect(decision.marginalCents).toBe(0);
    expect(decision.unspentHoursBefore).toBe(20);
  });

  it("does not reach the marketplace while guaranteed hours remain", () => {
    const decision = dispatch(
      job(),
      context([shonda({ hoursScheduledThisWeek: 0 }), contractor(), contractor({ id: "c2" })]),
    );
    expect(decision.kind).toBe("assign_guaranteed");
  });

  it("prefers the shortest drive among cleaners with hours left", () => {
    const near = shonda({ id: "near", name: "Near", hoursScheduledThisWeek: 10, lastStopZip: "75024" });
    const far = shonda({ id: "far", name: "Far", hoursScheduledThisWeek: 10, lastStopZip: "76102" });
    const ctx = {
      now: NOW,
      cleaners: [far, near],
      driveFor: (c: Cleaner) => (c.id === "near" ? { minutes: 5, miles: 3 } : { minutes: 45, miles: 30 }),
      rng: () => 0.5,
    };
    const decision = dispatch(job(), ctx);
    expect(decision.kind).toBe("assign_guaranteed");
    if (decision.kind !== "assign_guaranteed") return;
    expect(decision.cleaner.id).toBe("near");
  });

  it("stops assigning free hours once the guarantee is spent", () => {
    const decision = dispatch(job(), context([shonda({ hoursScheduledThisWeek: 40 }), contractor()]));
    expect(decision.kind).not.toBe("assign_guaranteed");
  });

  it("will not assign an ineligible cleaner even inside their guarantee", () => {
    // The gate is absolute — it applies before step 1, not after it.
    const barred = shonda({ hoursScheduledThisWeek: 0, backgroundCheckCleared: false });
    const decision = dispatch(job(), context([barred, contractor()]));
    expect(decision.kind).not.toBe("assign_guaranteed");
  });
});

describe("step 3 — board versus waterfall", () => {
  const full = () => shonda({ hoursScheduledThisWeek: 40 });

  it("posts scheduled work to the open board at the standard share", () => {
    const decision = dispatch(job(), context([full(), contractor()]));
    expect(decision.kind).toBe("open_board");
    if (decision.kind !== "open_board") return;
    expect(decision.share).toBe(0.33);
    expect(decision.payoutCents).toBe(5610); // 33% of a $170.00 ticket
  });

  it("promotes an unclaimed board job to the waterfall at T-72h", () => {
    const j = job();
    const decision = dispatch(j, context([full(), contractor()]));
    if (decision.kind !== "open_board") throw new Error("expected open_board");
    const gap = j.scheduledStart!.getTime() - decision.promoteToWaterfallAt.getTime();
    expect(gap / 3_600_000).toBe(URGENT_THRESHOLD_HOURS);
  });

  it("runs a timed waterfall for urgent work", () => {
    const urgent = job({ scheduledStart: new Date("2026-09-02T15:00:00Z") }); // 25h out
    const decision = dispatch(urgent, context([full(), contractor()]));
    expect(decision.kind).toBe("waterfall");
    if (decision.kind !== "waterfall") return;
    expect(decision.ladder[0]!.share).toBe(0.33);
    expect(decision.ladder.length).toBeGreaterThan(1);
  });

  it("caps the waterfall at the cheapest W-2 option for this specific job", () => {
    const urgent = job({ scheduledStart: new Date("2026-09-02T15:00:00Z") });
    const decision = dispatch(urgent, context([full(), iggy(), contractor()]));
    if (decision.kind !== "waterfall") throw new Error("expected waterfall");

    // Iggy at 20 min / 12 mi beats Shonda's overtime at $79.49. Exact cost is
    // $72.72 — the plan prints $72.71 because this row lands on a half cent.
    expect(decision.w2CeilingCents).toBe(7272);
    expect(decision.w2Fallback?.id).toBe("iggy");

    const topPayout = decision.ladder.at(-1)!.payoutCents;
    expect(topPayout).toBeLessThanOrEqual(decision.w2CeilingCents!);
  });

  it("flips the fallback to Shonda when the drive makes Iggy more expensive", () => {
    const urgent = job({ scheduledStart: new Date("2026-09-02T15:00:00Z") });
    const decision = dispatch(urgent, context([shonda({ hoursScheduledThisWeek: 40 }), iggy(), contractor()], 40, 24));
    if (decision.kind !== "waterfall") throw new Error("expected waterfall");
    // Past ~40 minutes Iggy's mileage overtakes Shonda's overtime.
    expect(decision.w2Fallback?.id).toBe("shonda");
  });

  it("treats an unscheduled job as not urgent", () => {
    expect(isUrgent(job({ scheduledStart: null }), NOW)).toBe(false);
  });
});

describe("no marketplace supply — the cold start", () => {
  it("falls back to the cheapest W-2 option rather than failing", () => {
    const decision = dispatch(
      job({ scheduledStart: new Date("2026-09-02T15:00:00Z") }),
      context([shonda({ hoursScheduledThisWeek: 40 }), iggy()]),
    );
    expect(decision.kind).toBe("assign_w2");
    if (decision.kind !== "assign_w2") return;
    expect(decision.cleaner.id).toBe("iggy");
    expect(decision.marginalCents).toBe(7272); // half-cent row; see marginal-cost.ts

  });

  it("reports honestly when nobody at all is eligible", () => {
    const decision = dispatch(job(), context([contractor({ rating: 2.0 })]));
    expect(decision.kind).toBe("no_eligible_cleaner");
  });

  it("reports honestly with an empty roster", () => {
    expect(dispatch(job(), context([])).kind).toBe("no_eligible_cleaner");
  });
});

describe("tiering", () => {
  it("ranks the marketplace and splits it into escalation tiers", () => {
    const pool = Array.from({ length: 7 }, (_, i) =>
      contractor({ id: `c${i}`, rating: 4 + i * 0.1, acceptanceRate: 0.5 + i * 0.05 }),
    );
    const decision = dispatch(
      job({ scheduledStart: new Date("2026-09-02T15:00:00Z") }),
      context([shonda({ hoursScheduledThisWeek: 40 }), ...pool]),
    );
    if (decision.kind !== "waterfall") throw new Error("expected waterfall");
    expect(decision.tiers.length).toBeGreaterThan(1);
    expect(decision.tiers.flat()).toHaveLength(7);
    // Best-ranked cleaner leads tier 1.
    expect(decision.tiers[0]![0]!.id).toBe("c6");
  });
});

describe("every decision explains itself", () => {
  it("carries a rationale an admin can read on the dispatch board", () => {
    const decisions = [
      dispatch(job(), context([shonda({ hoursScheduledThisWeek: 10 })])),
      dispatch(job(), context([shonda({ hoursScheduledThisWeek: 40 }), contractor()])),
      dispatch(job({ scheduledStart: new Date("2026-09-02T15:00:00Z") }), context([shonda({ hoursScheduledThisWeek: 40 }), contractor()])),
      dispatch(job(), context([])),
    ];
    for (const d of decisions) {
      expect(d.rationale.length).toBeGreaterThan(20);
    }
  });
});

describe("planning a whole board", () => {
  /**
   * The bug this exists to prevent: deciding each job independently tells every
   * job the same guaranteed hours are free, so a board of six jobs each claims
   * the same 8.5 unspent hours and the schedule silently over-commits.
   */
  function boardOf(n: number) {
    return Array.from({ length: n }, (_, i) =>
      job({
        id: `job-${i}`,
        scheduledStart: new Date(NOW.getTime() + (100 + i * 3) * 3_600_000),
      }),
    );
  }

  it("consumes guaranteed hours as it allocates them", () => {
    // 8.5h unspent; each job is 2.3h clean + 20min drive = 2.633h.
    // Three fit (7.9h), the fourth does not.
    const ctx = context([shonda({ hoursScheduledThisWeek: 31.5 }), contractor()]);
    const entries = dispatchBoard(boardOf(5), ctx);

    const free = entries.filter((e) => e.decision.kind === "assign_guaranteed");
    expect(free).toHaveLength(3);

    // The rest had to go somewhere other than free guaranteed hours.
    for (const e of entries.slice(3)) {
      expect(e.decision.kind).not.toBe("assign_guaranteed");
    }
  });

  it("never lets two jobs claim the same guaranteed hour", () => {
    const ctx = context([shonda({ hoursScheduledThisWeek: 31.5 }), contractor()]);
    const entries = dispatchBoard(boardOf(5), ctx);

    const assignedMinutes = entries
      .filter((e) => e.decision.kind === "assign_guaranteed")
      .reduce((a, e) => a + e.job.estimatedCleanMinutes + 20, 0);

    // Total free hours handed out cannot exceed what was actually unspent.
    expect(assignedMinutes / 60).toBeLessThanOrEqual(8.5);
  });

  it("reports the residual guarantee after the board is planned", () => {
    const ctx = context([shonda({ hoursScheduledThisWeek: 31.5 }), contractor()]);
    const entries = dispatchBoard(boardOf(5), ctx);
    const residual = residualGuaranteedHours(entries, ctx);

    const left = residual.get("shonda")!;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(8.5); // some was spent
  });

  it("plans soonest-first so urgent work gets first claim on cheap hours", () => {
    const soon = job({ id: "soon", scheduledStart: new Date(NOW.getTime() + 30 * 3_600_000) });
    const later = job({ id: "later", scheduledStart: new Date(NOW.getTime() + 200 * 3_600_000) });
    const ctx = context([shonda({ hoursScheduledThisWeek: 38 }), contractor()]);

    // Only ~2h of guarantee left — one job's worth. Pass them in the wrong order.
    const entries = dispatchBoard([later, soon], ctx);
    expect(entries[0]!.job.id).toBe("soon");
  });

  it("plans unscheduled jobs last", () => {
    const scheduled = job({ id: "scheduled" });
    const unscheduled = job({ id: "unscheduled", scheduledStart: null });
    const ctx = context([shonda({ hoursScheduledThisWeek: 20 }), contractor()]);
    const entries = dispatchBoard([unscheduled, scheduled], ctx);
    expect(entries.at(-1)!.job.id).toBe("unscheduled");
  });

  it("returns one entry per job and mutates nothing", () => {
    const roster = [shonda({ hoursScheduledThisWeek: 31.5 }), contractor()];
    const ctx = context(roster);
    const jobs = boardOf(4);
    const entries = dispatchBoard(jobs, ctx);

    expect(entries).toHaveLength(4);
    expect(new Set(entries.map((e) => e.job.id)).size).toBe(4);
    // The caller's roster is untouched.
    expect(roster[0]!.hoursScheduledThisWeek).toBe(31.5);
  });

  it("handles an empty board", () => {
    expect(dispatchBoard([], context([shonda()]))).toEqual([]);
  });
});

describe("appointment readiness before matching", () => {
  it.each([null, new Date("invalid"), new Date(NOW.getTime() - 1), NOW])(
    "does not offer or assign an unavailable appointment %s", (scheduledStart) => {
      const ctx = context([shonda({ hoursScheduledThisWeek: 0 }), contractor()]);
      ctx.driveFor = () => { throw new Error("Appointment must be checked before ranking"); };
      const d = dispatch(job({ scheduledStart }), ctx);
      expect(d.kind).toBe("needs_scheduling");
      expect(d.continuity).toEqual({ status: "none", reason: "appointment_requires_review" });
    },
  );
  it("leaves guaranteed capacity available for future visits and keeps blocked work on the board", () => {
    const roster = [shonda({ hoursScheduledThisWeek: 39 })];
    const ctx = context(roster, 0, 0);
    const entries = dispatchBoard([
      job({ id: "past", scheduledStart: new Date(NOW.getTime() - 1), estimatedCleanMinutes: 120 }),
      job({ id: "future", estimatedCleanMinutes: 30 }),
      job({ id: "missing", scheduledStart: null, estimatedCleanMinutes: 120 }),
    ], ctx);
    expect(entries.find(x => x.job.id === "past")?.decision.kind).toBe("needs_scheduling");
    expect(entries.find(x => x.job.id === "missing")?.decision.kind).toBe("needs_scheduling");
    expect(entries.find(x => x.job.id === "future")?.decision.kind).toBe("assign_guaranteed");
    expect(residualGuaranteedHours(entries, ctx).get("shonda")).toBe(.5);
    expect(roster[0]?.hoursScheduledThisWeek).toBe(39);
  });
});

describe("proposed appointment reservations within a batch", () => {
  it("does not suggest the same employee for overlapping visits, but permits adjacent visits", () => {
    const ctx = context([shonda({ hoursScheduledThisWeek: 0 })], 0, 0);
    const start = new Date("2026-09-10T15:00:00Z");
    const board = dispatchBoard([
      job({ id: "first", scheduledStart: start, scheduledEnd: new Date("2026-09-10T17:00:00Z"), estimatedCleanMinutes: 30 }),
      job({ id: "overlap", scheduledStart: new Date("2026-09-10T16:00:00Z"), estimatedCleanMinutes: 30 }),
      job({ id: "adjacent", scheduledStart: new Date("2026-09-10T17:00:00Z"), estimatedCleanMinutes: 30 }),
    ], ctx);
    expect(board.find(e => e.job.id === "first")?.decision.kind).toBe("assign_guaranteed");
    expect(board.find(e => e.job.id === "overlap")?.decision.kind).toBe("no_eligible_cleaner");
    expect(board.find(e => e.job.id === "adjacent")?.decision.kind).toBe("assign_guaranteed");
  });
  it("reserves a contractor's exclusive hold before considering a second overlapping visit", () => {
    const cleaner = contractor();
    const ctx = context([cleaner], 0, 0);
    const continuity = { preferredCleanerId: cleaner.id, incumbentCleanerId: null, priorVisits: 0 };
    const board = dispatchBoard([
      job({ id: "first", estimatedCleanMinutes: 90, continuity }),
      job({ id: "second", scheduledStart: new Date("2026-09-10T15:30:00Z"), estimatedCleanMinutes: 90, continuity }),
    ], ctx);
    expect(board[0]?.decision.kind).toBe("hold_for_incumbent");
    expect(board[1]?.decision.kind).toBe("no_eligible_cleaner");
  });
  it("keeps broadcast/open offers as choices rather than reserving every recipient", () => {
    const board = dispatchBoard([job({ id: "one" }), job({ id: "two" })], context([contractor()], 0, 0));
    expect(board.map(e => e.decision.kind)).toEqual(["open_board", "open_board"]);
  });
});

describe("saved load for each appointment week", () => {
  const current = new Date("2026-10-08T15:00:00Z");
  const visit = (id: string, start: string) => job({ id, estimatedCleanMinutes: 60, scheduledStart: new Date(start) });
  it("does not spend this week's forty hours again against next week's visit", () => {
    const ctx = { ...context([shonda({ hoursScheduledThisWeek: 40 })], 0), now: current, scheduledHoursFor: undefined };
    expect(dispatch(visit("next", "2026-10-12T16:00:00Z"), ctx).kind).toBe("assign_guaranteed");
    expect(dispatch(visit("now", "2026-10-09T16:00:00Z"), ctx).kind).toBe("assign_w2");
  });
  it("uses next week's saved forty hours even when this week is empty", () => {
    const ctx = { ...context([shonda({ hoursScheduledThisWeek: 0 })], 0), now: current,
      scheduledHoursFor: (_cleaner: Cleaner, week: string) => week === "2026-10-12" ? 40 : 0 };
    expect(dispatch(visit("next", "2026-10-12T16:00:00Z"), ctx).kind).toBe("assign_w2");
  });
  it("reserves hours separately for two weeks and reports each week's residual", () => {
    const ctx = { ...context([shonda()], 0), now: current, scheduledHoursFor: () => 39 };
    const entries = dispatchBoard([
      visit("one", "2026-10-09T16:00:00Z"), visit("two", "2026-10-09T18:00:00Z"),
      visit("three", "2026-10-12T16:00:00Z"), visit("four", "2026-10-12T18:00:00Z"),
    ], ctx);
    expect(entries.map(e => e.decision.kind)).toEqual(["assign_guaranteed", "assign_w2", "assign_guaranteed", "assign_w2"]);
    expect(residualGuaranteedHours(entries, ctx).get("shonda")).toBe(0);
    expect(residualGuaranteedHours(entries, ctx, matchingWeek(new Date("2026-10-12T16:00:00Z"))).get("shonda")).toBe(0);
  });
  it("does not consume unpaid travel inside a weekly guarantee", () => {
    const employee = shonda({ terms: { ...shonda().terms!, driveTimePaid: false } });
    const ctx = { ...context([employee], 30), now: current, scheduledHoursFor: () => 38 };
    const entries = dispatchBoard([visit("one", "2026-10-09T16:00:00Z"), visit("two", "2026-10-09T18:00:00Z")], ctx);
    expect(entries.every(e => e.decision.kind === "assign_guaranteed")).toBe(true);
    expect(residualGuaranteedHours(entries, ctx).get("shonda")).toBe(0);
  });
});
