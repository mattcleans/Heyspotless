import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingRequestTerms } from "./booking-request-terms";
import { toBookingReview } from "@/lib/booking/types";
import { bookingFixture } from "@/lib/booking/test-fixtures";
describe("original Client booking terms", () => {
  it("retains cadence, priced extras and escaped notes without asserting a current assignment or payment", () => {
    const review = toBookingReview({ ...bookingFixture, frequency: "biweekly", repeats: true,
      note: "<script>original notes</script>", totalCents: 11700, estimatedMinutes: 50,
      lines: [...bookingFixture.lines, { itemKey: "oven", name: "Oven Clean", quantity: 1, unitPriceCents: 5000, totalCents: 5000, cleanMinutes: 30, isExtra: true }] });
    const html = renderToStaticMarkup(createElement(BookingRequestTerms, { review }));
    expect(html).toContain("Original Client request");
    expect(html).toContain("Every other Friday");
    expect(html).toContain("Dallas time");
    expect(html).toContain("Oven Clean × 1");
    expect(html).toContain("$50.00");
    expect(html).toContain("$117.00");
    expect(html).toContain("per clean");
    expect(html).toContain("&lt;script&gt;original notes&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("assigned");
    expect(html).not.toContain("paid");
  });
  it("preserves the original single-visit repeat choice in a historical discounted receipt", () => {
    const html = renderToStaticMarkup(createElement(BookingRequestTerms, { review: toBookingReview({ ...bookingFixture, frequency: "biweekly", repeats: false }) }));
    expect(html).toContain("One visit; no recurring schedule will be created");
    expect(html).toContain("for this clean");
  });
});
