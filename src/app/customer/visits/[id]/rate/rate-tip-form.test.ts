import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { RatingReceipt } from "./rate-tip-form";

describe("saved rating receipt", () => {
  it("preserves the rating receipt when a tip fails without promising a payout", () => {
    const html = renderToStaticMarkup(createElement(RatingReceipt, {
      tipAddedCents: null,
      notice: "Online tipping is unavailable. Your rating was saved and no tip was added.",
    }));
    expect(html).toContain("Your rating is saved");
    expect(html).toContain("no tip was added");
    expect(html).not.toContain("tip was added to your bill");
    expect(html).not.toContain("will get");
  });
  it("describes a recorded tip as a bill item and preserves reconciliation warnings", () => {
    const html = renderToStaticMarkup(createElement(RatingReceipt, {
      tipAddedCents: 3980, notice: "the payout record needs checking",
    }));
    expect(html).toContain("$39.80 tip was added to your bill");
    expect(html).toContain("Check Account for the payment status");
    expect(html).toContain("the payout record needs checking");
    expect(html).not.toContain("will get");
  });
});
