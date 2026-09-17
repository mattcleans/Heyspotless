import { describe, expect, it } from "vitest";
import { SCREEN_QUESTIONS, screenScore, type ScreenInput } from "./screen";

function applicant(over: Partial<ScreenInput> = {}): ScreenInput {
  return {
    yearsExperience: 0,
    hasVehicle: null,
    workAuthorized: true,
    hasOwnInsurance: null,
    serviceZips: [],
    answers: null,
    ...over,
  };
}

describe("screenScore", () => {
  /**
   * Not a preference and not a weighting. Without the right to work there is
   * nothing to discuss, and the score says so rather than ranking somebody into
   * a queue that cannot hire them.
   */
  it("is zero without the right to work, whatever else is true", () => {
    const strong = applicant({
      workAuthorized: false,
      yearsExperience: 10,
      hasVehicle: true,
      hasOwnInsurance: true,
      serviceZips: ["75024"],
    });
    expect(screenScore(strong)).toBe(0);
  });

  it("weights the things dispatch will actually check", () => {
    const base = screenScore(applicant());
    expect(screenScore(applicant({ hasVehicle: true }))).toBeGreaterThan(base);
    expect(screenScore(applicant({ serviceZips: ["75024"] }))).toBeGreaterThan(base);
    expect(screenScore(applicant({ hasOwnInsurance: true }))).toBeGreaterThan(base);
  });

  /** One year to three is a real difference; eight to ten is noise. */
  it("stops paying for experience past five years", () => {
    expect(screenScore(applicant({ yearsExperience: 5 }))).toBe(
      screenScore(applicant({ yearsExperience: 20 })),
    );
    expect(screenScore(applicant({ yearsExperience: 1 }))).toBeLessThan(
      screenScore(applicant({ yearsExperience: 4 })),
    );
  });

  it("rewards answering the questions in sentences", () => {
    const answers = Object.fromEntries(
      SCREEN_QUESTIONS.map((q) => [q.key, "x".repeat(50)]),
    );
    expect(screenScore(applicant({ answers }))).toBeGreaterThan(screenScore(applicant()));
  });

  it("does not reward a one-word answer", () => {
    expect(screenScore(applicant({ answers: { experience: "yes" } }))).toBe(
      screenScore(applicant()),
    );
  });

  it("stays inside 0 and 100 for the strongest possible applicant", () => {
    const best = applicant({
      yearsExperience: 30,
      hasVehicle: true,
      hasOwnInsurance: true,
      serviceZips: ["75024", "75025"],
      answers: Object.fromEntries(SCREEN_QUESTIONS.map((q) => [q.key, "x".repeat(100)])),
    });
    const score = screenScore(best);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThan(90);
  });

  it("never goes negative on an empty application", () => {
    expect(screenScore(applicant({ workAuthorized: null }))).toBeGreaterThanOrEqual(0);
  });
});
