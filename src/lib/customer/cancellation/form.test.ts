import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import {
  CancellationReceiptDetails,
  VisitCancellationForm,
} from "@/components/visit-cancellation-form";
const receipt = {
  id: "id",
  jobId: "job",
  reason: "cancel" as const,
  scheduledStart: null,
  feeCents: 6000,
  invoiceId: null,
  billingReview: true,
  canceledAt: "2026-10-01T15:00:00Z",
};
describe("cancellation recovery and policy copy", () => {
  it("shows the exact fee boundary before review without a confirm button", () => {
    const html = renderToStaticMarkup(
      createElement(VisitCancellationForm, { jobId: "job", recurring: true }),
    );
    expect(html).toContain("previous evening");
    expect(html).toContain("Dallas time");
    expect(html).toContain("$60");
    expect(html).toContain("Skip only this recurring visit");
    expect(html).not.toContain("Confirm cancellation ·");
    expect(html).not.toContain("door_turnaway");
  });
  it("office can review door turnaways", () => {
    expect(
      renderToStaticMarkup(
        createElement(VisitCancellationForm, {
          jobId: "job",
          recurring: false,
          office: true,
        }),
      ),
    ).toContain("Record a door turnaway");
  });
  it("closed visit has no cancellation actions", () => {
    const html = renderToStaticMarkup(
      createElement(VisitCancellationForm, {
        jobId: "job",
        recurring: true,
        closed: true,
      }),
    );
    expect(html).toContain("already started or closed");
    expect(html).not.toContain("<button");
  });
  it("preview disables review", () => {
    const html = renderToStaticMarkup(
      createElement(VisitCancellationForm, {
        jobId: "job",
        recurring: true,
        preview: true,
      }),
    );
    expect(html).toContain("Preview only");
    expect(html).toContain("disabled");
  });
  it("payment review never claims a charge or refund was completed", () => {
    const html = renderToStaticMarkup(
      createElement(CancellationReceiptDetails, { receipt }),
    );
    expect(html).toContain("$60.00 cancellation fee recorded");
    expect(html).toContain("reconcile an existing payment");
    expect(html).toContain("did not start another payment");
    expect(html).not.toContain("has been charged");
  });
  it("free cancellation receipt does not change the series", () => {
    const html = renderToStaticMarkup(
      createElement(CancellationReceiptDetails, {
        receipt: { ...receipt, feeCents: 0, billingReview: false },
      }),
    );
    expect(html).toContain("No cancellation fee");
    expect(html).toContain("does not change your recurring schedule");
    expect(html).not.toContain("View account balance");
  });
  it("requires explicit account payment for a fee without promising autopay collection", () => {
    const html = renderToStaticMarkup(
      createElement(CancellationReceiptDetails, {
        receipt: { ...receipt, billingReview: false, invoiceId: "fee-invoice" },
      }),
    );
    expect(html).toContain("Pay it through Account");
    expect(html).toContain("will not be charged automatically");
    expect(html).toContain('href="/customer/account"');
    expect(html).not.toContain("follows your existing payment settings");
  });
});
