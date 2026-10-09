import { describe, expect, it } from "vitest";
import { matchingWeek } from "./week";
describe("Dallas Monday weeks", () => {
  it.each([
    ["2026-10-12T04:59:59Z", "2026-10-05"],
    ["2026-10-12T05:00:00Z", "2026-10-12"],
    ["2026-03-09T04:59:59Z", "2026-03-02"],
    ["2026-03-09T05:00:00Z", "2026-03-09"],
    ["2026-11-02T05:59:59Z", "2026-10-26"],
    ["2026-11-02T06:00:00Z", "2026-11-02"],
  ])("places %s in %s", (instant, expected) => expect(matchingWeek(new Date(instant))).toBe(expected));
});
