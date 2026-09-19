import { describe, expect, it } from "vitest";
import { isStageReached, roomProgress, visitHeadline, type VisitSummary } from "./progress";

function visit(over: Partial<VisitSummary> = {}): VisitSummary {
  return {
    stage: "cleaning",
    scheduledStart: new Date("2026-09-26T14:00:00Z"),
    startedAt: new Date("2026-09-26T14:04:00Z"),
    completedAt: null,
    expectedFinishAt: new Date("2026-09-26T16:30:00Z"),
    roomsDone: 4,
    roomsTotal: 9,
    ...over,
  };
}

describe("isStageReached", () => {
  it("lights every stage up to the current one", () => {
    expect(isStageReached("scheduled", "cleaning")).toBe(true);
    expect(isStageReached("accepted", "cleaning")).toBe(true);
    expect(isStageReached("cleaning", "cleaning")).toBe(true);
    expect(isStageReached("done", "cleaning")).toBe(false);
  });
});

describe("visitHeadline", () => {
  it("names the cleaner when there is one", () => {
    expect(visitHeadline(visit(), "Maria")).toBe("Maria is cleaning now");
    expect(visitHeadline(visit({ stage: "done" }), "Maria")).toBe("Maria has finished");
  });

  /** Before the engine has matched anybody, there is no name to use. */
  it("does not invent a cleaner before one is matched", () => {
    expect(visitHeadline(visit({ stage: "scheduled" }), null)).toBe(
      "We are matching you with a cleaner",
    );
  });

  it("copes with a cleaner whose name we do not have", () => {
    expect(visitHeadline(visit(), null)).toBe("Your cleaner is cleaning now");
  });
});

describe("roomProgress", () => {
  it("is the fraction of rooms with evidence", () => {
    expect(roomProgress(visit())).toBeCloseTo(4 / 9, 10);
  });

  /**
   * A clock-based bar claims to know how long this house takes, and the
   * estimate is ours. A bar at 90% while she is still on the second bathroom
   * is worse than no bar at all.
   */
  it("shows nothing before she has started", () => {
    expect(roomProgress(visit({ stage: "accepted" }))).toBeNull();
    expect(roomProgress(visit({ stage: "scheduled" }))).toBeNull();
  });

  it("is full when she is finished", () => {
    expect(roomProgress(visit({ stage: "done" }))).toBe(1);
  });

  it("never exceeds full, even with more photos than rooms", () => {
    expect(roomProgress(visit({ roomsDone: 12, roomsTotal: 9 }))).toBe(1);
  });

  it("shows nothing rather than dividing by zero", () => {
    expect(roomProgress(visit({ roomsTotal: 0 }))).toBeNull();
  });
});
