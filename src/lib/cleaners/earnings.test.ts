import { describe, expect, it } from "vitest";
import { filterPayRecords, parsePayFilter, summarizePayRecords, toAssignmentPay, toPayRecord } from "./earnings";

const raw = { id: "p1", job_id: "j1", amount_cents: 8250, mileage_cents: 500, tip_cents: 1000, tip_fee_cents: 29, tip_net_cents: 971, created_at: "2026-10-02T00:30:00Z", paid_at: null, period_start: "2026-09-21", period_end: "2026-09-27" };
const pending = toPayRecord(raw, true);
const paid = toPayRecord({ ...raw, id: "p2", paid_at: "2026-10-03T15:00:00Z" }, true);
describe("recorded pay", () => {
  it("counts the cleaner's net tip exactly once", () => {
    expect(summarizePayRecords([pending, paid])).toMatchObject({ workCents: 16500, mileageCents: 1000, tipNetCents: 1942, pendingCents: 9721, paidCents: 9721 });
  });
  it("a work amount of zero with a tip is a tip-only record, not unpaid work", () => {
    expect(summarizePayRecords([toPayRecord({ ...raw, amount_cents: 0, mileage_cents: 0 }, true)]).pendingCents).toBe(971);
  });
  it("marks missing tip data unknown rather than zero", () => {
    const legacy = toPayRecord({ ...raw, tip_cents: undefined, tip_fee_cents: undefined, tip_net_cents: undefined }, false);
    expect(legacy.tipNetCents).toBeNull();
    expect(summarizePayRecords([legacy])).toMatchObject({ tipsKnown: false, tipNetCents: null, pendingCents: 8750 });
  });
  it("preserves negative work adjustments", () => {
    expect(summarizePayRecords([toPayRecord({ ...raw, amount_cents: -200 }, true)]).pendingCents).toBe(1271);
  });
  it.each([NaN, null, "8250", 0.5])("rejects an unreadable work amount %s", amount_cents => {
    expect(() => toPayRecord({ ...raw, amount_cents }, true)).toThrow("recorded pay");
  });
  it("does not treat a malformed paid timestamp as awaiting payment", () => {
    expect(() => toPayRecord({ ...raw, paid_at: "invalid" }, true)).toThrow("pay dates");
  });
  it("requires tip cents to reconcile", () => {
    expect(() => toPayRecord({ ...raw, tip_net_cents: 970 }, true)).toThrow("tip details need review");
  });
  it("reads actual assignment pay, including imported zeroes, without deriving it from a ticket", () => {
    const assignment = toAssignmentPay({ job_id: "j1", payout_cents: 0, jobs: { price_cents: 50000, status: "complete", scheduled_start: null, customers: { first_name: "Ann", last_name: "A" }, properties: { street: "Test street" } } });
    expect(assignment).toMatchObject({ agreedCents: 0, customerName: "Ann A", status: "complete", scheduledStart: null });
  });
});
describe("pay filters", () => {
  it("uses the Dallas recorded day rather than UTC or the payment date", () => {
    expect(filterPayRecords([pending, paid], parsePayFilter({ from: "2026-10-01", through: "2026-10-01" }))).toEqual([pending, paid]);
    expect(filterPayRecords([pending, paid], parsePayFilter({ from: "2026-10-02", through: "2026-10-03" }))).toEqual([]);
  });
  it("handles the midnight boundary during daylight savings time", () => {
    const record = toPayRecord({ ...raw, created_at: "2026-11-01T05:30:00Z" }, true);
    expect(filterPayRecords([record], parsePayFilter({ from: "2026-11-01", through: "2026-11-01" }))).toEqual([record]);
  });
  it("filters pending versus recorded paid using a recorded payment date", () => {
    expect(filterPayRecords([pending, paid], parsePayFilter({ status: "pending" }))).toEqual([pending]);
    expect(filterPayRecords([pending, paid], parsePayFilter({ status: "paid" }))).toEqual([paid]);
  });
  it.each([{ status: "complete" }, { status: ["paid", "pending"] }, { from: "2026-02-30" }, { from: ["2026-10-01"] }, { from: "2026-10-03", through: "2026-10-02" }])("rejects misleading or malformed filters %j", query => {
    expect(() => parsePayFilter(query)).toThrow();
  });
  it("empty date controls clear the range without changing records", () => {
    expect(filterPayRecords([pending], parsePayFilter({ from: "", through: "", status: "all" }))).toEqual([pending]);
  });
});
