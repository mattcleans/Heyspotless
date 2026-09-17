import { describe, expect, it } from "vitest";
import {
  formatMinutes,
  responseMinutes,
  responseStats,
  urgencyOf,
  waitingMinutes,
  type LeadRow,
} from "./leads";

const RECEIVED = new Date("2026-09-17T15:00:00Z");
const NOW = new Date("2026-09-17T18:00:00Z");

function lead(over: Partial<LeadRow> = {}): LeadRow {
  return {
    id: crypto.randomUUID(),
    firstName: "Dana",
    lastName: "Reyes",
    phone: "+12145550143",
    email: null,
    rawAddress: "9 Reply Road",
    zip: "75024",
    status: "new",
    source: "website",
    service: "standard",
    frequency: "biweekly",
    bedrooms: 3,
    bathrooms: 2,
    quotedPriceCents: 17000,
    receivedAt: RECEIVED,
    firstResponseAt: null,
    smsConsentAt: RECEIVED,
    attribution: null,
    ...over,
  };
}

describe("responseMinutes", () => {
  it("measures from the enquiry to the first human answer", () => {
    const answered = lead({ firstResponseAt: new Date("2026-09-17T15:12:00Z") });
    expect(responseMinutes(answered)).toBe(12);
  });

  it("is null while nobody has answered", () => {
    expect(responseMinutes(lead())).toBeNull();
  });
});

describe("waitingMinutes", () => {
  it("counts how long an open lead has been waiting", () => {
    expect(waitingMinutes(lead(), NOW)).toBe(180);
  });

  it("stops counting once somebody has answered", () => {
    expect(waitingMinutes(lead({ firstResponseAt: NOW }), NOW)).toBeNull();
  });

  /** A lead that was won is not waiting, however long it took to get there. */
  it("does not count a decided lead as waiting", () => {
    expect(waitingMinutes(lead({ status: "won" }), NOW)).toBeNull();
    expect(waitingMinutes(lead({ status: "lost" }), NOW)).toBeNull();
    expect(waitingMinutes(lead({ status: "spam" }), NOW)).toBeNull();
  });
});

describe("responseStats", () => {
  /**
   * The median rather than the mean, because one lead answered three days late
   * drags a mean into fiction — and the number is supposed to describe what a
   * typical customer experiences.
   */
  it("reports the median response time, not the mean", () => {
    const stats = responseStats(
      [
        lead({ firstResponseAt: new Date(RECEIVED.getTime() + 5 * 60_000) }),
        lead({ firstResponseAt: new Date(RECEIVED.getTime() + 10 * 60_000) }),
        lead({ firstResponseAt: new Date(RECEIVED.getTime() + 3 * 24 * 60 * 60_000) }),
      ],
      NOW,
    );

    expect(stats.medianMinutes).toBe(10);
    expect(stats.answered).toBe(3);
  });

  it("averages the middle two when the count is even", () => {
    const stats = responseStats(
      [
        lead({ firstResponseAt: new Date(RECEIVED.getTime() + 10 * 60_000) }),
        lead({ firstResponseAt: new Date(RECEIVED.getTime() + 20 * 60_000) }),
      ],
      NOW,
    );
    expect(stats.medianMinutes).toBe(15);
  });

  it("surfaces the longest-waiting lead, which is the thing to do next", () => {
    const stats = responseStats(
      [lead(), lead({ receivedAt: new Date("2026-09-16T15:00:00Z") })],
      NOW,
    );
    expect(stats.waiting).toBe(2);
    expect(stats.longestWaitingMinutes).toBe(27 * 60);
  });

  /**
   * Counting this morning's open enquiries as losses makes the number
   * meaningless on any day the business is busy.
   */
  it("excludes undecided leads from the conversion rate", () => {
    const stats = responseStats(
      [lead({ status: "won" }), lead({ status: "lost" }), lead({ status: "new" })],
      NOW,
    );
    expect(stats.conversionRate).toBe(0.5);
  });

  it("has no conversion rate at all before anything is decided", () => {
    expect(responseStats([lead()], NOW).conversionRate).toBeNull();
  });

  it("survives an empty book", () => {
    const stats = responseStats([], NOW);
    expect(stats).toEqual({
      answered: 0,
      waiting: 0,
      medianMinutes: null,
      longestWaitingMinutes: null,
      conversionRate: null,
    });
  });
});

describe("formatMinutes", () => {
  it("reads at a glance", () => {
    expect(formatMinutes(4)).toBe("4m");
    expect(formatMinutes(130)).toBe("2h 10m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(60 * 24 * 3)).toBe("3d");
    expect(formatMinutes(null)).toBe("—");
  });
});

describe("urgencyOf", () => {
  it("marks the hour, the afternoon and the lost cause", () => {
    expect(urgencyOf(30)).toBe("fresh");
    expect(urgencyOf(120)).toBe("slipping");
    expect(urgencyOf(60 * 30)).toBe("cold");
    expect(urgencyOf(null)).toBeNull();
  });
});
