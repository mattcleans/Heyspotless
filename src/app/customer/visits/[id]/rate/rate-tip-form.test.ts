import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { RateTipForm, RatingReceipt } from "./rate-tip-form";

describe("reopened rating form", () => {
  it("restores the saved score, highlights and private note with an update action", () => {
    const html = renderToStaticMarkup(createElement(RateTipForm, {
      jobId: "job", cleanerFirstName: "Preview", cleanPriceCents: 19900,
      tipsEnabled: false,
      initialRating: { score: 5, highlights: ["thorough"], privateNote: "SYNTHETIC PREVIEW ONLY: saved note" },
    }));
    expect(html).toContain("Saved rating: 5 out of 5");
    expect(html).toContain('aria-label="5 out of 5" aria-pressed="true"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Thorough<\/button>/);
    expect(html).toContain("SYNTHETIC PREVIEW ONLY: saved note</textarea>");
    expect(html).toContain("Update rating");
    expect(html).toContain("Online tipping is unavailable");
    expect(html).not.toContain("Add a tip");
  });
  it("keeps an unrated visit empty without a saved-rating claim", () => {
    const html = renderToStaticMarkup(createElement(RateTipForm, {
      jobId: "job", cleanerFirstName: "Preview", cleanPriceCents: 19900,
      tipsEnabled: false,
    }));
    expect(html).not.toContain("Saved rating");
    expect(html).not.toContain("Update rating");
    expect(html).not.toContain('aria-pressed="true"');
  });
});

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
