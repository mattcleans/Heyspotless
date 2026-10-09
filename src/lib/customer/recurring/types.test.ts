import { describe, it, expect } from "vitest";
import {
  parseScheduleDraft,
  toScheduleQuote,
  toScheduleReceipt,
  receiptMatchesQuote,
} from "./types";
const id = "d9000000-0000-0000-0000-000000000001",
  job = "d4000000-0000-0000-0000-000000000001";
const visit = {
  job_id: null,
  action: "added",
  previous_start: null,
  new_start: "2026-10-03T15:30:00+00:00",
  previous_occurrence: null,
  new_occurrence: "2026-10-03",
  previous_epoch: null,
  new_epoch: 2,
  previous_price_cents: null,
  new_price_cents: 20000,
  reason: "New appointment in the pattern",
  released_count: 0,
  fills_date: "2026-10-03",
};
const raw = {
  id,
  expires_at: "2026-10-02T15:05:00Z",
  review: {
    plan_id: id,
    effective_from: "2026-10-03",
    first_date: "2026-10-03",
    freq: "weekly",
    start_time: "10:30:00",
    paused_until: null,
    ends_on: null,
    price_cents: 20000,
    previous_price_cents: 20000,
    estimated_minutes: 90,
    fee_cents: 0,
    horizon_until: "2026-11-14",
    visits: [visit],
    preserved_skips: ["2026-10-10"],
  },
};
const draft = {
  firstDate: "2026-10-03",
  frequency: "weekly",
  startTime: "10:30",
  pausedUntil: "",
  endsOn: "",
};
describe("recurring schedule review contracts", () => {
  it("accepts Dallas wall-clock choices without parsing the browser time zone", () =>
    expect(parseScheduleDraft(draft)).toEqual(draft));
  it.each([
    { firstDate: "2026-02-30" },
    { firstDate: "infinity" },
    { startTime: "24:00" },
    { startTime: "10:30:01" },
    { frequency: "daily" },
    { endsOn: "2026-10-02" },
    { pausedUntil: null },
  ])("rejects unusable draft %j", (bad) =>
    expect(() => parseScheduleDraft({ ...draft, ...bad })).toThrow(),
  );
  it("requires the saved job ID for every newly added appointment", () => {
    const quote = toScheduleQuote(raw);
    expect(quote.review.visits[0]!.job_id).toBeNull();
    expect(() =>
      toScheduleReceipt({ ...raw, confirmed_at: "2026-10-02T15:01:00Z" }),
    ).toThrow();
  });
  it("compares all saved prices, dates, actions and release counts, allowing only new job IDs", () => {
    const quote = toScheduleQuote(raw),
      saved = {
        ...raw,
        confirmed_at: "2026-10-02T15:01:00Z",
        review: { ...raw.review, visits: [{ ...visit, job_id: job }] },
      };
    const receipt = toScheduleReceipt(saved);
    expect(receiptMatchesQuote(receipt, quote)).toBe(true);
    const changed = toScheduleReceipt({
      ...saved,
      review: {
        ...saved.review,
        visits: [{ ...visit, job_id: job, new_start: "2026-10-04T15:30:00Z" }],
      },
    });
    expect(receiptMatchesQuote(changed, quote)).toBe(false);
    expect(receiptMatchesQuote({ ...receipt, id: job }, quote)).toBe(false);
  });
  it("matches JSON objects regardless of key order", () => {
    const quote = toScheduleQuote(raw),
      reversed = Object.fromEntries(
        Object.entries({ ...visit, job_id: job }).reverse(),
      );
    const receipt = toScheduleReceipt({
      ...raw,
      confirmed_at: "2026-10-02T15:01:00Z",
      review: { ...raw.review, visits: [reversed] },
    });
    expect(receiptMatchesQuote(receipt, quote)).toBe(true);
  });
  it.each([
    { fee_cents: 6000 },
    { visits: [{ ...visit, action: "removed" }] },
    { visits: [{ ...visit, job_id: job }] },
    { visits: [{ ...visit, new_start: "October 3" }] },
    { visits: [{ ...visit, new_epoch: 0 }] },
    { price_cents: -1 },
    { preserved_skips: ["2026-02-30"] },
  ])("fails closed for malformed review %j", (bad) =>
    expect(() =>
      toScheduleQuote({ ...raw, review: { ...raw.review, ...bad } }),
    ).toThrow(),
  );
  it("retained visits must keep their actual time, price and assignments", () => {
    const kept = {
      ...visit,
      job_id: job,
      action: "kept",
      previous_start: visit.new_start,
      previous_epoch: 1,
      previous_price_cents: 20000,
    };
    expect(
      toScheduleQuote({ ...raw, review: { ...raw.review, visits: [kept] } })
        .review.visits[0]!.action,
    ).toBe("kept");
    expect(() =>
      toScheduleQuote({
        ...raw,
        review: { ...raw.review, visits: [{ ...kept, released_count: 1 }] },
      }),
    ).toThrow();
  });
  it("drops unexpected private columns from client-visible review", () =>
    expect(
      JSON.stringify(
        toScheduleQuote({
          ...raw,
          review: {
            ...raw.review,
            snapshot: "secret",
            visits: [{ ...visit, payout_cents: 9000 }],
          },
        }),
      ),
    ).not.toMatch(/secret|payout/));
});
