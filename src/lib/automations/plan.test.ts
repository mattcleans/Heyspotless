import { describe, expect, it } from "vitest";
import {
  ACTION_BOOKING_CONFIRMED,
  ACTION_LEAD_NUDGE_1,
  ACTION_LEAD_NUDGE_3,
  ACTION_REVIEW_REQUEST,
  ACTION_VISIT_REMINDER,
  CONFIRMATION_WINDOW_HOURS,
  NUDGE_HOURS,
  REVIEW_DELAY_HOURS,
  automationKey,
  eveningBefore,
  isBackfill,
  nudgeStep,
  planForJob,
  planForLead,
  type PlannableJob,
  type PlannableLead,
} from "./plan";
import { formatDateTimeInZone } from "../time/zone";

/**
 * The planner decides what the business says to a customer and when. Every
 * case here is one somebody would otherwise find out about from a customer.
 */

const NOW = new Date("2026-09-17T15:00:00Z"); // 10am Thursday in Chicago

function job(over: Partial<PlannableJob> = {}): PlannableJob {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    status: "scheduled",
    createdAt: NOW,
    scheduledStart: new Date("2026-09-22T15:00:00Z"), // Tuesday, 10am Chicago
    completedAt: null,
    ...over,
  };
}

function actions(plans: ReturnType<typeof planForJob>): string[] {
  return plans.map((p) => p.actionKey).sort();
}

describe("planForJob", () => {
  it("plans a confirmation and a reminder for a freshly booked visit", () => {
    expect(actions(planForJob(job(), NOW))).toEqual([
      ACTION_BOOKING_CONFIRMED,
      ACTION_VISIT_REMINDER,
    ]);
  });

  it("keys every action to its subject so the queue cannot hold two", () => {
    const [first] = planForJob(job(), NOW);
    expect(first?.dedupeKey).toBe(
      automationKey("job", "11111111-1111-1111-1111-111111111111", ACTION_BOOKING_CONFIRMED),
    );
  });

  it("plans nothing at all for a canceled visit", () => {
    expect(planForJob(job({ status: "canceled" }), NOW)).toEqual([]);
  });

  it("plans nothing for a visit with no date", () => {
    expect(planForJob(job({ scheduledStart: null }), NOW)).toEqual([]);
  });

  it("plans nothing for a visit that has already started", () => {
    const past = new Date(NOW.getTime() - 3_600_000);
    expect(planForJob(job({ scheduledStart: past }), NOW)).toEqual([]);
  });

  /**
   * The migration guard. Phase 09 inserts several hundred existing visits in
   * one transaction; without this every one of them is confirmed by text to a
   * real customer about a booking they made months ago.
   */
  it("does not confirm a visit that was created long ago", () => {
    const old = new Date(NOW.getTime() - (CONFIRMATION_WINDOW_HOURS + 1) * 3_600_000);
    expect(actions(planForJob(job({ createdAt: old }), NOW))).toEqual([ACTION_VISIT_REMINDER]);
  });

  it("still confirms one booked just inside the window", () => {
    const recent = new Date(NOW.getTime() - (CONFIRMATION_WINDOW_HOURS - 1) * 3_600_000);
    expect(actions(planForJob(job({ createdAt: recent }), NOW))).toContain(
      ACTION_BOOKING_CONFIRMED,
    );
  });

  /** Two texts an hour apart about one clean teaches people to ignore both. */
  it("does not confirm a visit less than a day away — the reminder covers it", () => {
    const tomorrowish = new Date(NOW.getTime() + 20 * 3_600_000);
    expect(actions(planForJob(job({ scheduledStart: tomorrowish }), NOW))).not.toContain(
      ACTION_BOOKING_CONFIRMED,
    );
  });

  it("skips a reminder whose evening has already passed", () => {
    // Booked at 9pm Chicago for 10am tomorrow: 6pm "the day before" is behind us.
    const lateNow = new Date("2026-09-22T02:00:00Z"); // 9pm Mon in Chicago
    const plans = planForJob(
      job({ createdAt: lateNow, scheduledStart: new Date("2026-09-22T15:00:00Z") }),
      lateNow,
    );
    expect(actions(plans)).not.toContain(ACTION_VISIT_REMINDER);
  });

  it("asks how it went a few hours after the clean, not at the door", () => {
    const completedAt = new Date("2026-09-17T18:00:00Z");
    const plans = planForJob(job({ status: "complete", completedAt, scheduledStart: null }), NOW);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.actionKey).toBe(ACTION_REVIEW_REQUEST);
    expect(plans[0]?.scheduledFor.getTime()).toBe(
      completedAt.getTime() + REVIEW_DELAY_HOURS * 3_600_000,
    );
  });

  /**
   * A job finished late is a job whose review request is late. Planning it off
   * the schedule instead would ask about a clean that had not happened yet.
   */
  it("times the review request from when the clean finished, not when it was due", () => {
    const scheduledStart = new Date("2026-09-17T14:00:00Z");
    const completedAt = new Date("2026-09-17T20:30:00Z"); // ran six hours late
    const plans = planForJob(job({ status: "complete", scheduledStart, completedAt }), NOW);

    expect(plans[0]?.scheduledFor.getTime()).toBe(
      completedAt.getTime() + REVIEW_DELAY_HOURS * 3_600_000,
    );
  });
});

describe("eveningBefore", () => {
  it("is 6pm the previous day in business time", () => {
    const at = eveningBefore(new Date("2026-09-22T15:00:00Z"));
    expect(formatDateTimeInZone(at!)).toContain("Sep 21");
    expect(formatDateTimeInZone(at!)).toContain("6:00");
  });

  /**
   * The case fixed-offset arithmetic gets wrong. An early-morning visit on the
   * Monday after the clocks change: `start - 24h` lands on the wrong DAY, and
   * the reminder tells the customer their Monday clean is "tomorrow" on Saturday.
   */
  it("stays on the previous calendar day across a daylight-saving boundary", () => {
    // 1 November 2026 is the fall-back Sunday in Chicago.
    const visit = new Date("2026-11-02T13:00:00Z"); // 7am Monday in Chicago
    const at = eveningBefore(visit);
    expect(formatDateTimeInZone(at!)).toContain("Nov 1");
  });

  it("is not affected by the server's own zone", () => {
    const visit = new Date("2026-09-22T15:00:00Z");
    expect(eveningBefore(visit, "America/Chicago")?.toISOString()).toBe(
      eveningBefore(visit)?.toISOString(),
    );
  });
});

describe("planForLead", () => {
  const RECEIVED = new Date("2026-09-17T15:00:00Z");

  function lead(over: Partial<PlannableLead> = {}): PlannableLead {
    return {
      id: "22222222-2222-2222-2222-222222222222",
      status: "new",
      receivedAt: RECEIVED,
      firstResponseAt: null,
      smsConsentAt: RECEIVED,
      phone: "+12145550143",
      ...over,
    };
  }

  it("queues three nudges over three days", () => {
    const plans = planForLead(lead(), RECEIVED);
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => (p.scheduledFor.getTime() - RECEIVED.getTime()) / 3_600_000)).toEqual([
      ...NUDGE_HOURS,
    ]);
  });

  it("files them under the lead, not the job", () => {
    expect(planForLead(lead(), RECEIVED)[0]?.subjectType).toBe("lead");
  });

  /**
   * The failure everybody has received from somebody else's CRM: a chasing
   * text about something you already bought.
   */
  it("stops chasing a lead that was won or lost", () => {
    expect(planForLead(lead({ status: "won" }), RECEIVED)).toEqual([]);
    expect(planForLead(lead({ status: "lost" }), RECEIVED)).toEqual([]);
    expect(planForLead(lead({ status: "spam" }), RECEIVED)).toEqual([]);
  });

  /** A person getting there first is the outcome the sequence exists to avoid needing. */
  it("stops chasing once a person has answered", () => {
    expect(planForLead(lead({ firstResponseAt: new Date() }), RECEIVED)).toEqual([]);
  });

  /** A2P: no consent timestamp, no campaign traffic. Not negotiable. */
  it("sends nothing without consent on file", () => {
    expect(planForLead(lead({ smsConsentAt: null }), RECEIVED)).toEqual([]);
  });

  it("sends nothing without a number", () => {
    expect(planForLead(lead({ phone: null }), RECEIVED)).toEqual([]);
  });

  /**
   * An old lead — the sweep was down, or it was imported. Catching up would
   * fire all three at once, which is the worst possible first impression.
   */
  it("skips rungs that are already overdue rather than catching up", () => {
    const later = new Date(RECEIVED.getTime() + 30 * 3_600_000);
    const plans = planForLead(lead(), later);
    expect(plans.map((p) => p.actionKey)).toEqual([ACTION_LEAD_NUDGE_3]);
  });

  it("plans nothing at all once the sequence is finished", () => {
    const wellAfter = new Date(RECEIVED.getTime() + 100 * 3_600_000);
    expect(planForLead(lead(), wellAfter)).toEqual([]);
  });
});

describe("nudgeStep", () => {
  it("maps each action to its place in the sequence", () => {
    expect(nudgeStep(ACTION_LEAD_NUDGE_1)).toBe(1);
    expect(nudgeStep(ACTION_LEAD_NUDGE_3)).toBe(3);
  });

  it("does not claim a job action is a nudge", () => {
    expect(nudgeStep(ACTION_VISIT_REMINDER)).toBeNull();
  });
});

describe("backfill", () => {
  /**
   * The failure this prevents is a specific one, and it happens once: the
   * Housecall Pro import lands, and every customer whose last clean was in the
   * last couple of days is texted asking how it went — about a clean this
   * system never saw, from a business they have not heard from this way before.
   */
  it("does not ask for a review of a clean that was imported after it happened", () => {
    const completedAt = new Date("2026-09-16T18:00:00Z");
    const imported = job({
      status: "complete",
      completedAt,
      scheduledStart: null,
      createdAt: NOW, // written today, about yesterday
    });

    expect(isBackfill(imported)).toBe(true);
    expect(planForJob(imported, NOW)).toEqual([]);
  });

  it("still asks about a clean the system watched happen", () => {
    const createdAt = new Date("2026-09-10T12:00:00Z");
    const completedAt = new Date("2026-09-17T18:00:00Z");
    const real = job({ status: "complete", createdAt, completedAt, scheduledStart: null });

    expect(isBackfill(real)).toBe(false);
    expect(actions(planForJob(real, NOW))).toEqual([ACTION_REVIEW_REQUEST]);
  });

  /** A row written by a sweep that ran a few minutes late is not an import. */
  it("allows an hour of slack", () => {
    const completedAt = new Date("2026-09-17T12:00:00Z");
    const slightlyLate = job({
      status: "complete",
      completedAt,
      createdAt: new Date(completedAt.getTime() + 30 * 60_000),
      scheduledStart: null,
    });
    expect(isBackfill(slightlyLate)).toBe(false);
  });

  it("says nothing about a job that has not finished", () => {
    expect(isBackfill(job())).toBe(false);
  });
});
