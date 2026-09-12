import { describe, expect, it } from "vitest";
import { windowsOn, type DeclaredWindow } from "./availability";

/**
 * These are zone assertions as much as availability ones, which is why the
 * suite runs under UTC and America/Chicago in CI. A cleaner who works nine to
 * three works nine to three in both March and November; if any of this is
 * derived from the server's clock instead of the business calendar, one of the
 * two runs fails.
 */

const weekly = (entries: [number, DeclaredWindow[]][]) => new Map(entries);

describe("windowsOn", () => {
  it("returns undefined when nothing has been declared at all", () => {
    // Unknown, not "works no hours" — the eligibility gate must not invent a
    // constraint out of a roster that has never filled this in.
    expect(windowsOn(new Date("2026-09-08T15:00:00Z"), undefined)).toBeUndefined();
    expect(windowsOn(new Date("2026-09-08T15:00:00Z"), weekly([]))).toBeUndefined();
  });

  it("returns an empty array for a day she declared nothing on", () => {
    // She works Tuesdays. This is a Wednesday. That is a real answer, not a
    // missing one, and it is honoured.
    const tuesdays = weekly([[2, [{ startsAt: "09:00:00", endsAt: "15:00:00" }]]]);
    expect(windowsOn(new Date("2026-09-09T15:00:00Z"), tuesdays)).toEqual([]);
  });

  it("builds the window in business time, not the server's", () => {
    // Tuesday 8 September 2026, 09:00–15:00 in Chicago (CDT, UTC-5).
    const tuesdays = weekly([[2, [{ startsAt: "09:00:00", endsAt: "15:00:00" }]]]);
    const windows = windowsOn(new Date("2026-09-08T15:00:00Z"), tuesdays);

    expect(windows).toHaveLength(1);
    expect(windows?.[0]?.start.toISOString()).toBe("2026-09-08T14:00:00.000Z");
    expect(windows?.[0]?.end.toISOString()).toBe("2026-09-08T20:00:00.000Z");
  });

  it("keeps her hours fixed across the daylight-saving change", () => {
    // The point of storing a local time rather than an instant. Both are
    // Tuesdays; one is on CDT and one on CST, and 09:00 stays 09:00 for her.
    const tuesdays = weekly([[2, [{ startsAt: "09:00:00", endsAt: "15:00:00" }]]]);

    const summer = windowsOn(new Date("2026-09-08T15:00:00Z"), tuesdays);
    const winter = windowsOn(new Date("2026-12-08T15:00:00Z"), tuesdays);

    expect(summer?.[0]?.start.toISOString()).toBe("2026-09-08T14:00:00.000Z");
    // One hour later in UTC, because Chicago is on standard time — and the
    // same wall clock for the cleaner, which is the part that matters.
    expect(winter?.[0]?.start.toISOString()).toBe("2026-12-08T15:00:00.000Z");
  });

  it("reads the weekday where the business is", () => {
    // 00:30 UTC on Wednesday is Tuesday evening in Dallas. Reading the
    // server's weekday would look up Wednesday's hours for a Tuesday job.
    const tuesdays = weekly([[2, [{ startsAt: "09:00:00", endsAt: "15:00:00" }]]]);
    const windows = windowsOn(new Date("2026-09-09T00:30:00Z"), tuesdays);
    expect(windows).toHaveLength(1);
  });

  it("keeps a split shift as two windows", () => {
    const split = weekly([
      [2, [
        { startsAt: "08:00:00", endsAt: "11:00:00" },
        { startsAt: "14:00:00", endsAt: "18:00:00" },
      ]],
    ]);
    const windows = windowsOn(new Date("2026-09-08T15:00:00Z"), split);
    expect(windows).toHaveLength(2);
  });

  it("drops a window that ends before it starts rather than inverting it", () => {
    const nonsense = weekly([[2, [{ startsAt: "15:00:00", endsAt: "09:00:00" }]]]);
    expect(windowsOn(new Date("2026-09-08T15:00:00Z"), nonsense)).toEqual([]);
  });

  it("accepts HH:MM as well as the HH:MM:SS Postgres returns", () => {
    const short = weekly([[2, [{ startsAt: "09:00", endsAt: "15:00" }]]]);
    expect(windowsOn(new Date("2026-09-08T15:00:00Z"), short)).toHaveLength(1);
  });
});
