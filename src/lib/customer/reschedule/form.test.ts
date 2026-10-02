import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import {
  VisitRescheduleForm,
  RescheduleReceiptDetails,
} from "@/components/visit-reschedule-form";
import { parseRescheduleTime, checkedReschedule } from "./types";
const props = {
  jobId: "job",
  currentStart: "2026-10-01T15:00:00Z",
  recurring: true,
};
describe("single-visit rescheduling policy", () => {
  it("starts with a review step in Dallas time and retains a submitted time", () => {
    const html = renderToStaticMarkup(
      createElement(VisitRescheduleForm, {
        ...props,
        initialStart: "2026-10-03T10:00",
      }),
    );
    expect(html).toContain('value="2026-10-03T10:00"');
    expect(html).toContain("moving to another day costs $60");
    expect(html).toContain("Review new appointment");
    expect(html).toContain("recurring schedule stays the same");
    expect(html).not.toContain("Confirm new appointment");
  });
  it("renders closed visits without save actions", () => {
    const html = renderToStaticMarkup(
      createElement(VisitRescheduleForm, { ...props, closed: true }),
    );
    expect(html).toContain("already started or closed");
    expect(html).not.toContain("<button");
  });
  it("preview has disabled save actions", () => {
    const html = renderToStaticMarkup(
      createElement(VisitRescheduleForm, { ...props, preview: true }),
    );
    expect(html).toContain("Preview only");
    expect(html).toContain("disabled");
  });
  it("a saved time does not promise a matched cleaner, payment or changed series", () => {
    const html = renderToStaticMarkup(
      createElement(RescheduleReceiptDetails, {
        receipt: {
          id: "quote",
          jobId: "job",
          previousStart: props.currentStart,
          newStart: "2026-10-03T15:00:00Z",
          newEnd: "2026-10-03T16:30:00Z",
          priceCents: 20000,
          feeCents: 0,
          releasedCount: 1,
          confirmedAt: "2026-10-01T12:00:00Z",
          invoiceId: null,
        },
      }),
    );
    expect(html).toContain("Your visit has moved");
    expect(html).toContain("No rescheduling fee");
    expect(html).toContain("$200.00");
    expect(html).toContain("current assignment");
    expect(html).toContain("backup needs your approval");
    expect(html).not.toContain("charged");
  });
  it("resolves the repeated autumn hour to its first occurrence", () => {
    const parsed = parseRescheduleTime("2026-11-01T01:30");
    expect(parsed.ambiguous).toBe(true);
    expect(parsed.date.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
  it("a paid receipt records the fee separately without claiming a card charge", () => {
    const html = renderToStaticMarkup(
      createElement(RescheduleReceiptDetails, {
        receipt: {
          id: "quote",
          jobId: "job",
          previousStart: props.currentStart,
          newStart: "2026-10-03T15:00:00Z",
          newEnd: "2026-10-03T16:30:00Z",
          priceCents: 20000,
          feeCents: 6000,
          releasedCount: 1,
          confirmedAt: "2026-10-01T12:00:00Z",
          invoiceId: "invoice",
        },
      }),
    );
    expect(html).toContain("$60.00 rescheduling fee recorded");
    expect(html).toContain("Visit price: $200.00");
    expect(html).toContain("does not charge your card");
    expect(html).not.toContain("No rescheduling fee");
  });
  it("refuses nonexistent spring times instead of moving an appointment silently", () => {
    expect(() => parseRescheduleTime("2026-03-08T02:30")).toThrow(
      "does not exist",
    );
  });
  it("validates browser receipts before claiming a save", () => {
    expect(() => checkedReschedule({ id: "bad", feeCents: 0 }, true)).toThrow();
  });
});
