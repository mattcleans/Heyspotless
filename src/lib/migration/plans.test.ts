import { describe, expect, it } from "vitest";
import { mapJob } from "./hcp";
import {
  buildPlans,
  frequencyFromGap,
  medianGapDays,
  parsePlanOverrides,
  type PlanJob,
  type PlanOverride,
} from "./plans";
import { addCalendarDays, type CalendarDate } from "../time/zone";

const TODAY = "2026-09-28" as CalendarDate;

function planJob(
  n: number,
  date: string | null,
  overrides: Record<string, string> = {},
  propertyKey = "c1:100 oak st",
): PlanJob {
  const mapped = mapJob({
    job: String(n),
    customer_name: "Paula Marsh",
    job_description: "Standard Cleaning",
    job_status: "Completed",
    job_amount: "$150.00",
    job_scheduled_start_date: date ? `${date}T10:00:00-05:00` : "",
    recurring: "true",
    ...overrides,
  });
  if (!mapped.ok) throw new Error(mapped.problem);
  return { job: mapped.value, customerHcpId: propertyKey.split(":")[0]!, propertyKey };
}

/** Visits `gap` days apart, the last of them on `last`. */
function every(gap: number, count: number, last = "2026-09-14"): string[] {
  return Array.from({ length: count }, (_, i) => addCalendarDays(last as CalendarDate, -gap * (count - 1 - i)));
}

describe("frequencyFromGap — the bands, inclusive, with gaps between them", () => {
  it.each([
    [4, null],
    [5, "weekly"],
    [7, "weekly"],
    [9, "weekly"],
    [10, null],
    [11, null],
    [12, "biweekly"],
    [14, "biweekly"],
    [16, "biweekly"],
    [17, null],
    [25, null],
    [26, "monthly"],
    [28, "monthly"],
    [35, "monthly"],
    [36, null],
    [10.5, null],
  ])("%s days → %s", (days, freq) => {
    expect(frequencyFromGap(days)).toBe(freq);
  });
});

describe("medianGapDays", () => {
  it("is null with fewer than three visits — two are a coincidence", () => {
    expect(medianGapDays(every(14, 2) as CalendarDate[])).toBeNull();
  });

  it("takes the median, not the mean, so one skipped visit does not move it", () => {
    const dates = ["2026-07-06", "2026-07-20", "2026-08-17", "2026-08-31", "2026-09-14"] as CalendarDate[];
    // Gaps 14, 28, 14, 14.
    expect(medianGapDays(dates)).toBe(14);
  });

  it("uses only the most recent six visits — the current cadence", () => {
    // Weekly for months, then fortnightly for the last six visits.
    const weekly = every(7, 10, "2026-05-01");
    const biweekly = every(14, 6, "2026-08-31");
    expect(medianGapDays([...weekly, ...biweekly] as CalendarDate[])).toBe(14);
  });

  it("averages the middle two of an even number of gaps", () => {
    // Gaps 10, 12 → 11.
    expect(medianGapDays(["2026-08-01", "2026-08-11", "2026-08-23"] as CalendarDate[])).toBe(11);
  });

  it("sorts its input", () => {
    expect(medianGapDays(["2026-08-29", "2026-08-01", "2026-08-15"] as CalendarDate[])).toBe(14);
  });
});

describe("buildPlans — inferred", () => {
  it("makes a fortnightly plan at the latest non-zero price, anchored on the next visit", () => {
    const dates = every(14, 5);
    const jobs = [
      ...dates.map((d, i) => planJob(i, d, { job_amount: i === 4 ? "$0.00" : i >= 2 ? "$154.00" : "$150.00" })),
      planJob(9, "2026-10-12", { job_status: "Scheduled", job_amount: "$154.00" }),
    ];
    const { plans, gaps } = buildPlans(jobs, new Map(), TODAY);
    expect(gaps).toEqual([]);
    expect(plans).toEqual([
      expect.objectContaining({
        hcpPlanId: "c1:100 oak st:biweekly",
        customerHcpId: "c1",
        propertyKey: "c1:100 oak st",
        freq: "biweekly",
        service: "standard",
        agreedPriceCents: 15400,
        anchorDate: "2026-10-12",
        active: true,
        source: "inferred",
        jobCount: 6,
        medianGapDays: 14,
      }),
    ]);
  });

  it("is inactive and anchored on the last completed visit when nothing is upcoming", () => {
    const jobs = every(28, 4).map((d, i) => planJob(i, d));
    const [plan] = buildPlans(jobs, new Map(), TODAY).plans;
    expect(plan).toMatchObject({ freq: "monthly", active: false, anchorDate: "2026-09-14" });
  });

  it("lists a customer whose spacing is in no band as needing a person", () => {
    const jobs = ["2026-08-01", "2026-08-11", "2026-08-22", "2026-09-02"].map((d, i) => planJob(i, d));
    const { plans, gaps } = buildPlans(jobs, new Map(), TODAY);
    expect(plans).toEqual([]);
    expect(gaps).toEqual([
      { customerHcpId: "c1", propertyKey: "c1:100 oak st", jobCount: 4, medianGapDays: 11, reason: "needs frequency" },
    ]);
  });

  it("lists a customer with fewer than three recurring visits as needing a person", () => {
    const { gaps } = buildPlans([planJob(1, "2026-09-01"), planJob(2, "2026-09-15")], new Map(), TODAY);
    expect(gaps).toMatchObject([{ reason: "needs frequency", jobCount: 2, medianGapDays: null }]);
  });

  /** A customer who books a one-off every month has not agreed a monthly rate. */
  it("never infers a plan from jobs that are not marked recurring", () => {
    const jobs = every(14, 6).map((d, i) => planJob(i, d, { recurring: "false" }));
    expect(buildPlans(jobs, new Map(), TODAY)).toEqual({ plans: [], gaps: [] });
  });

  it("ignores canceled visits", () => {
    const jobs = [
      ...every(14, 3).map((d, i) => planJob(i, d)),
      planJob(8, "2026-09-20", { job_status: "Canceled" }),
    ];
    const [plan] = buildPlans(jobs, new Map(), TODAY).plans;
    expect(plan).toMatchObject({ freq: "biweekly", jobCount: 3 });
  });

  it("makes no plan without a price, and says so", () => {
    const jobs = every(14, 3).map((d, i) => planJob(i, d, { job_amount: "$0.00" }));
    const { plans, gaps } = buildPlans(jobs, new Map(), TODAY);
    expect(plans).toEqual([]);
    expect(gaps).toMatchObject([{ reason: "no price" }]);
  });

  it("keeps one plan per property", () => {
    const a = every(7, 4).map((d, i) => planJob(i, d, {}, "c1:100 oak st"));
    const b = every(28, 4).map((d, i) => planJob(10 + i, d, {}, "c1:12 lake rd"));
    const { plans } = buildPlans([...a, ...b], new Map(), TODAY);
    expect(plans.map((p) => [p.hcpPlanId, p.freq])).toEqual([
      ["c1:100 oak st:weekly", "weekly"],
      ["c1:12 lake rd:monthly", "monthly"],
    ]);
  });
});

describe("the plans override file", () => {
  it("parses a complete row", () => {
    const { overrides, problems } = parsePlanOverrides([
      {
        customer_email_or_phone: "paula@example.com",
        street: "100 Oak St",
        freq: "Every other week",
        service: "Standard",
        agreed_price: "$140.00",
        anchor_date: "2026-10-05",
        active: "true",
      },
    ]);
    expect(problems).toEqual([]);
    expect(overrides).toEqual([
      {
        row: 1,
        customerContact: "paula@example.com",
        street: "100 Oak St",
        freq: "biweekly",
        service: "standard",
        agreedPriceCents: 14000,
        anchorDate: "2026-10-05",
        active: true,
      },
    ]);
  });

  it("needs only the customer and the frequency", () => {
    const { overrides } = parsePlanOverrides([{ customer_email_or_phone: "2145550101", freq: "monthly" }]);
    expect(overrides[0]).toMatchObject({ street: null, service: null, agreedPriceCents: null, anchorDate: null, active: null });
  });

  it.each([
    [{ freq: "weekly" }, "plan override: no customer_email_or_phone"],
    [{ customer_email_or_phone: "a@b.c", freq: "sometimes" }, "plan override: freq must be weekly, biweekly or monthly"],
    [{ customer_email_or_phone: "a@b.c", freq: "one-time" }, "plan override: freq must be weekly, biweekly or monthly"],
    [{ customer_email_or_phone: "a@b.c", freq: "weekly", agreed_price: "TBD" }, "plan override: unreadable agreed_price"],
    [{ customer_email_or_phone: "a@b.c", freq: "weekly", anchor_date: "10/5/2026" }, "plan override: anchor_date must be YYYY-MM-DD"],
    [{ customer_email_or_phone: "a@b.c", freq: "weekly", service: "carpets" }, "plan override: unrecognised service"],
  ])("refuses %o", (row, reason) => {
    const { overrides, problems } = parsePlanOverrides([row]);
    expect(overrides).toEqual([]);
    expect(problems[0]?.reason).toBe(reason);
  });
});

describe("buildPlans — an override always wins", () => {
  function override(fields: Partial<PlanOverride>): Map<string, PlanOverride & { customerHcpId: string }> {
    return new Map([
      [
        "c1:100 oak st",
        {
          row: 1,
          customerContact: "paula@example.com",
          street: null,
          freq: "monthly",
          service: null,
          agreedPriceCents: null,
          anchorDate: null,
          active: null,
          customerHcpId: "c1",
          ...fields,
        },
      ],
    ]);
  }

  it("over the frequency the spacing says", () => {
    const jobs = every(14, 5).map((d, i) => planJob(i, d));
    const [plan] = buildPlans(jobs, override({ freq: "monthly" }), TODAY).plans;
    expect(plan).toMatchObject({ freq: "monthly", source: "override", hcpPlanId: "c1:100 oak st:monthly" });
  });

  it("for a customer the spacing could not decide", () => {
    const jobs = ["2026-08-01", "2026-08-11", "2026-08-22"].map((d, i) => planJob(i, d));
    const { plans, gaps } = buildPlans(jobs, override({ freq: "weekly" }), TODAY);
    expect(gaps).toEqual([]);
    expect(plans[0]).toMatchObject({ freq: "weekly", source: "override", agreedPriceCents: 15000 });
  });

  it("over price, service, anchor and active, each on its own", () => {
    const jobs = [...every(14, 3).map((d, i) => planJob(i, d)), planJob(9, "2026-10-12", { job_status: "Scheduled" })];
    const [plan] = buildPlans(
      jobs,
      override({ freq: "biweekly", agreedPriceCents: 13500, service: "deep", anchorDate: "2026-11-02" as CalendarDate, active: false }),
      TODAY,
    ).plans;
    expect(plan).toMatchObject({ agreedPriceCents: 13500, service: "deep", anchorDate: "2026-11-02", active: false });
  });

  it("even with no recurring jobs behind it, when it states a price and an anchor", () => {
    const { plans } = buildPlans(
      [],
      override({ freq: "weekly", agreedPriceCents: 12000, anchorDate: "2026-10-01" as CalendarDate }),
      TODAY,
    );
    expect(plans[0]).toMatchObject({ freq: "weekly", jobCount: 0, active: false, source: "override" });
  });

  it("marks the imported jobs with the plan's frequency", () => {
    const jobs = every(14, 3).map((d, i) => planJob(i, d));
    const [plan] = buildPlans(jobs, override({ freq: "biweekly" }), TODAY).plans;
    expect(plan?.jobHcpIds).toEqual(["0", "1", "2"]);
  });
});
