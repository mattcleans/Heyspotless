import { describe, expect, it } from "vitest";
import {
  RATINGS_BEFORE_SHOWING,
  displayName,
  firstName,
  initials,
  languageLabel,
  ratingDisplay,
  specialtyLabel,
  tenureLabel,
} from "./profile";

describe("displayName", () => {
  /**
   * A customer needs to recognise her at the door and say her name. They do
   * not need a string they could put into a search engine.
   */
  it("is a first name and an initial, never the full legal name", () => {
    expect(displayName("Maria Gonzalez")).toBe("Maria G.");
    expect(displayName("Denise Rodriguez")).toBe("Denise R.");
  });

  it("uses the last name when there are several", () => {
    expect(displayName("Ana Teresa Ruiz")).toBe("Ana R.");
  });

  it("copes with one name", () => {
    expect(displayName("Shonda")).toBe("Shonda");
  });

  it("never renders an empty label", () => {
    expect(displayName("")).toBe("Your cleaner");
    expect(displayName("   ")).toBe("Your cleaner");
  });
});

describe("initials", () => {
  it("is the avatar before a photo exists", () => {
    expect(initials("Maria Gonzalez")).toBe("MG");
    expect(initials("Shonda")).toBe("S");
    expect(initials("")).toBe("?");
  });
});

describe("firstName", () => {
  it("is what a sentence uses", () => {
    expect(firstName("Maria Gonzalez")).toBe("Maria");
    expect(firstName("")).toBe("Your cleaner");
  });
});

describe("tenureLabel", () => {
  const NOW = new Date("2026-09-19T12:00:00Z");

  it("counts years and months", () => {
    expect(tenureLabel(new Date("2023-09-19T12:00:00Z"), NOW)).toBe("3 yrs");
    expect(tenureLabel(new Date("2025-09-19T12:00:00Z"), NOW)).toBe("1 yr");
    expect(tenureLabel(new Date("2026-01-19T12:00:00Z"), NOW)).toBe("8 mo");
  });

  /**
   * A cleaner eleven months in is not "1 yr with us". The number is a trust
   * signal, and inflating it by a month makes every other number worth less.
   */
  it("rounds down, always", () => {
    expect(tenureLabel(new Date("2025-10-19T12:00:00Z"), NOW)).toBe("11 mo");
  });

  it("says New rather than nothing", () => {
    expect(tenureLabel(null, NOW)).toBe("New");
    expect(tenureLabel(new Date("2026-09-10T12:00:00Z"), NOW)).toBe("New");
  });
});

describe("ratingDisplay", () => {
  /**
   * 0024 averages against a prior worth five reviews, so a cleaner nobody has
   * rated still shows 4.2. Printing that as a rating presents an assumption as
   * a measurement.
   */
  it("hides the number until enough real ratings exist", () => {
    const shown = ratingDisplay(4.2, 0);
    expect(shown.show).toBe(false);
    expect(shown.rating).toBeNull();
    expect(shown.label).toBe("New to Hey Spotless");
  });

  it("still hides it just below the threshold", () => {
    expect(ratingDisplay(4.9, RATINGS_BEFORE_SHOWING - 1).show).toBe(false);
  });

  it("shows it once the measurement is real", () => {
    const shown = ratingDisplay(4.9, 214);
    expect(shown.show).toBe(true);
    expect(shown.rating).toBe(4.9);
    expect(shown.label).toBe("214 reviews");
  });

  it("does not claim a rating it was given none for", () => {
    expect(ratingDisplay(null, 40).show).toBe(false);
  });
});

describe("labels", () => {
  it("renders the fixed catalogue", () => {
    expect(specialtyLabel("pet_friendly")).toBe("Pet-friendly");
    expect(specialtyLabel("deep")).toBe("Deep cleaning");
    expect(languageLabel("es")).toBe("Speaks Spanish");
  });

  it("falls back to the raw key rather than rendering nothing", () => {
    expect(specialtyLabel("windows")).toBe("windows");
  });
});

describe("tenureLabel, at the boundaries", () => {
  const NOW = new Date("2026-09-19T12:00:00Z");

  /**
   * The case that caught the first implementation. A year is 365 days and an
   * average month is 30.44, so elapsed-milliseconds arithmetic reports 11.99
   * months on the anniversary and prints "11 mo".
   */
  it("says 1 yr on the anniversary itself", () => {
    expect(tenureLabel(new Date("2025-09-19T00:00:00Z"), NOW)).toBe("1 yr");
  });

  it("still says 11 mo the day before", () => {
    expect(tenureLabel(new Date("2025-09-20T00:00:00Z"), NOW)).toBe("11 mo");
  });

  it("counts a month only once the day of the month has come round", () => {
    expect(tenureLabel(new Date("2026-08-19T00:00:00Z"), NOW)).toBe("1 mo");
    expect(tenureLabel(new Date("2026-08-20T00:00:00Z"), NOW)).toBe("New");
  });

  it("is never negative for a date in the future", () => {
    expect(tenureLabel(new Date("2027-01-01T00:00:00Z"), NOW)).toBe("New");
  });
});
