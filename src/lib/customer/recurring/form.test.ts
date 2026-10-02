import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import {
  RecurringScheduleForm,
  RecurringReview,
} from "@/components/recurring-schedule-form";
import { toScheduleReview } from "./types";
describe("recurring schedule microcopy", () => {
  it("starts with an editable review step and preserves choices after sign-in", () => {
    const html = renderToStaticMarkup(
      createElement(RecurringScheduleForm, {
        planId: "plan",
        initialDraft: {
          firstDate: "2026-10-03",
          frequency: "biweekly",
          startTime: "10:30",
          pausedUntil: "",
          endsOn: "",
        },
        minDate: "2026-10-03",
        maxDate: "2027-10-03",
      }),
    );
    expect(html).toContain("Review dates and price");
    expect(html).not.toContain("Confirm future schedule");
    expect(html).toContain('value="10:30"');
    expect(html).toContain("frequency change reviews the current price");
    expect(html).toContain("Dallas");
  });
  it("explains protected visits, free future edits, and the correct same-day fee boundary", () => {
    const review = toScheduleReview({
      plan_id: "d9000000-0000-0000-0000-000000000001",
      effective_from: "2026-10-03",
      first_date: "2026-10-03",
      freq: "monthly",
      start_time: "10:30",
      paused_until: "2026-10-20",
      ends_on: null,
      price_cents: 20000,
      previous_price_cents: 15000,
      estimated_minutes: 90,
      fee_cents: 0,
      horizon_until: "2026-11-14",
      visits: [],
      preserved_skips: ["2026-10-10"],
    });
    const html = renderToStaticMarkup(
      createElement(RecurringReview, { review }),
    );
    expect(html).toContain("Every visit affected");
    expect(html).toContain("another day costs $60");
    expect(html).toContain("another time today is free");
    expect(html).toContain("Previously $150");
    expect(html).toContain("approve any proposed backup");
    expect(html).toContain("Previously skipped dates stay skipped");
    expect(html).toContain("No future visits in this review");
  });
});
it("shows a removed recurring visit as a free recorded cancellation", async () => {
  const { RecurringVisitChanges } =
    await import("@/components/recurring-visit-changes");
  const html = renderToStaticMarkup(
    createElement(RecurringVisitChanges, {
      changes: [
        {
          id: "change",
          planId: "plan",
          action: "removed",
          previousStart: "2026-10-13T14:30Z",
          newStart: null,
          priceCents: null,
          reason: "Outside the new pattern",
          savedAt: "2026-10-02T15:00Z",
        },
      ],
    }),
  );
  expect(html).toContain("canceled without a cancellation fee");
  expect(html).toContain("/customer/schedules/plan");
  expect(html).not.toContain("payment was refunded");
});
it("offers only supported recurring frequencies for a deep clean", () => {
  const html = renderToStaticMarkup(
    createElement(RecurringScheduleForm, {
      planId: "plan",
      service: "deep",
      initialDraft: {
        firstDate: "2026-10-03",
        frequency: "monthly",
        startTime: "10:30",
        pausedUntil: "",
        endsOn: "",
      },
      minDate: "2026-10-03",
      maxDate: "2027-10-03",
    }),
  );
  expect(html).toContain('<option value="monthly"');
  expect(html).not.toContain('<option value="weekly"');
});
