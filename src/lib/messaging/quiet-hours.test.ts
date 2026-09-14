import { describe, expect, it } from "vitest";
import {
  QUIET_HOURS_END,
  QUIET_HOURS_START,
  URGENT_OVERRIDE_HOURS,
  isQuietHour,
  nextSendWindow,
  sendWindowFor,
} from "./quiet-hours";

/**
 * Quiet hours are business-local, so this suite is really a zone suite — which
 * is why CI runs it under UTC and America/Chicago. If any of this leans on the
 * server's clock, one of the two runs fails.
 */

/** 14:00 UTC is 09:00 in Chicago on a summer date. */
const MORNING = new Date("2026-09-15T14:00:00Z");
/** 02:00 UTC is 21:00 the previous evening in Chicago. */
const EVENING = new Date("2026-09-16T02:00:00Z");
/** 11:00 UTC is 06:00 in Chicago. */
const EARLY = new Date("2026-09-15T11:00:00Z");

describe("isQuietHour", () => {
  it("is quiet in the evening and the small hours, business time", () => {
    expect(isQuietHour(EVENING)).toBe(true);
    expect(isQuietHour(EARLY)).toBe(true);
  });

  it("is not quiet during the working day", () => {
    expect(isQuietHour(MORNING)).toBe(false);
  });

  it("opens exactly at the boundary and closes exactly at it", () => {
    // 08:00 Chicago = 13:00 UTC on this date; 20:00 Chicago = 01:00 UTC next.
    expect(isQuietHour(new Date("2026-09-15T13:00:00Z"))).toBe(false);
    expect(isQuietHour(new Date("2026-09-15T12:59:00Z"))).toBe(true);
    expect(isQuietHour(new Date("2026-09-16T01:00:00Z"))).toBe(true);
    expect(isQuietHour(new Date("2026-09-16T00:59:00Z"))).toBe(false);
  });

  it("holds the same wall clock across the daylight-saving change", () => {
    // Both are 09:00 in Chicago; one is on CDT and one on CST. The hour a
    // cleaner may be texted must not move an hour twice a year.
    expect(isQuietHour(new Date("2026-09-15T14:00:00Z"))).toBe(false);
    expect(isQuietHour(new Date("2026-12-15T15:00:00Z"))).toBe(false);
    // And the boundary moves with it rather than staying put in UTC.
    expect(isQuietHour(new Date("2026-12-15T13:00:00Z"))).toBe(true);
  });
});

describe("nextSendWindow", () => {
  it("returns now when now is already fine", () => {
    expect(nextSendWindow(MORNING).getTime()).toBe(MORNING.getTime());
  });

  it("walks forward to the next opening rather than doing wall-clock maths", () => {
    // 21:00 Chicago → the following 08:00. Stepping an hour at a time is what
    // keeps this correct on the two days a year when adding an hour to 01:30
    // does not produce 02:30.
    const next = nextSendWindow(EVENING);
    expect(isQuietHour(next)).toBe(false);
    expect(next.getTime()).toBeGreaterThan(EVENING.getTime());
    expect(next.getTime() - EVENING.getTime()).toBeLessThanOrEqual(12 * 3600_000);
  });
});

describe("sendWindowFor", () => {
  it("sends during the working day", () => {
    const window = sendWindowFor(MORNING, { hoursUntilJob: 200 });
    expect(window.send).toBe(true);
    if (window.send) expect(window.reason).toBe("in_hours");
  });

  it("holds an ordinary offer overnight and says when it will go", () => {
    const window = sendWindowFor(EVENING, { hoursUntilJob: 200 });
    expect(window.send).toBe(false);
    if (window.send) return;
    expect(window.reason).toBe("quiet_hours");
    expect(isQuietHour(window.nextOpening)).toBe(false);
  });

  it("sends anyway when the job is close enough that waiting is worse", () => {
    // A clean booked for 9am with no cleaner at 6am. Deferring to 08:00 leaves
    // an hour to fill it; the 6am text is the lesser harm.
    const window = sendWindowFor(EARLY, { hoursUntilJob: 3 });
    expect(window.send).toBe(true);
    if (window.send) expect(window.reason).toBe("urgent_override");
  });

  it("does not treat a far-off job as urgent just because it is quiet", () => {
    const window = sendWindowFor(EARLY, { hoursUntilJob: URGENT_OVERRIDE_HOURS });
    expect(window.send).toBe(false);
  });

  it("never defers an unscheduled job for ever", () => {
    // Infinity is not urgent, so it waits for the morning like anything else,
    // rather than falling through some numeric edge.
    const window = sendWindowFor(EARLY, { hoursUntilJob: Number.POSITIVE_INFINITY });
    expect(window.send).toBe(false);
  });

  it("keeps the window a policy number rather than a scattered literal", () => {
    expect(QUIET_HOURS_START).toBe(20);
    expect(QUIET_HOURS_END).toBe(8);
  });
});
