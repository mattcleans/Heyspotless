import { describe, expect, it } from "vitest";
import { parseAvailability } from "./availability-input";

describe("cleaner working hours", () => {
  it("sorts split shifts and allows adjacent windows without mutating input", () => {
    const input = [{ day: 2, startsAt: "13:00", endsAt: "17:00" }, { day: 2, startsAt: "09:00", endsAt: "13:00" }];
    expect(parseAvailability(input).map(w => w.startsAt)).toEqual(["09:00", "13:00"]);
    expect(input[0]!.startsAt).toBe("13:00");
  });
  it.each([null, [], new Array(29).fill({ day: 0, startsAt: "09:00", endsAt: "10:00" })])("does not turn an empty or oversized declaration into working hours", value => {
    expect(() => parseAvailability(value)).toThrow();
  });
  it.each([-1, 7, 1.5, "1"]) ("rejects an invalid weekday %s", day => {
    expect(() => parseAvailability([{ day, startsAt: "09:00", endsAt: "10:00" }])).toThrow();
  });
  it.each([["24:00", "25:00"], ["9:00", "10:00"], ["09:60", "10:00"], ["17:00", "09:00"], ["09:00", "09:00"]])("rejects invalid or overnight times %s to %s", (startsAt, endsAt) => {
    expect(() => parseAvailability([{ day: 1, startsAt, endsAt }])).toThrow();
  });
  it("rejects duplicate, overlapping and nested windows", () => {
    for (const start of ["09:00", "10:00", "11:00"]) expect(() => parseAvailability([
      { day: 1, startsAt: "09:00", endsAt: "15:00" }, { day: 1, startsAt: start, endsAt: "12:00" },
    ])).toThrow(/overlap/);
  });
});
