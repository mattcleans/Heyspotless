import { describe, expect, it } from "vitest";
import { parseRefundDollars, REFUND_CHOICES, refundChoice, refundableCents } from "./refund-options";
import { REFUND_KINDS } from "./types";

describe("the reasons Management can give", () => {
  it("offers every stated kind and never unattributed", () => {
    const offered = REFUND_CHOICES.map((c) => c.kind);
    expect(offered).not.toContain("unattributed");
    expect(new Set(offered)).toEqual(new Set(REFUND_KINDS.filter((k) => k !== "unattributed")));
  });

  it("finds a choice by kind and refuses anything else", () => {
    expect(refundChoice("goodwill")?.label).toMatch(/goodwill/i);
    expect(refundChoice("unattributed")).toBeNull();
    expect(refundChoice("")).toBeNull();
  });
});

describe("what can still be refunded", () => {
  it("is the whole payment when nothing has been refunded", () => {
    expect(refundableCents(17000, [])).toBe(17000);
  });

  it("subtracts succeeded and pending refunds", () => {
    expect(refundableCents(17000, [
      { amountCents: 5000, status: "succeeded" },
      { amountCents: 2000, status: "pending" },
    ])).toBe(10000);
  });

  it("ignores refunds that failed or were canceled", () => {
    expect(refundableCents(17000, [
      { amountCents: 5000, status: "failed" },
      { amountCents: 5000, status: "canceled" },
    ])).toBe(17000);
  });

  it("never goes below zero", () => {
    expect(refundableCents(100, [{ amountCents: 300, status: "succeeded" }])).toBe(0);
  });
});

describe("reading a typed amount", () => {
  it.each([
    ["12", 1200],
    ["12.5", 1250],
    ["12.50", 1250],
    ["$12.50", 1250],
    ["1,234.56", 123456],
    [" 0.01 ", 1],
  ])("reads %j as %d cents", (input, cents) => {
    expect(parseRefundDollars(input)).toBe(cents);
  });

  it.each(["", "0", "0.00", "-5", "12.345", "abc", "12.5.0", "1e3"])("refuses %j", (input) => {
    expect(parseRefundDollars(input)).toBeNull();
  });
});
