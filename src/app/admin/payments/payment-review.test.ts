import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const m = vi.hoisted(() => ({ profile: vi.fn(), list: vi.fn(), client: vi.fn(), demo: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), notFound: () => { throw new Error("not_found"); } }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ({ getCurrentProfile: m.profile }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
vi.mock("@/lib/billing/review-store", () => ({ listPaymentReviews: m.list }));
vi.mock("@/lib/supabase/env", () => ({ isDemoMode: m.demo }));
import Page from "./page";
import { PaymentReviewList } from "./payment-review-list";
import { paymentReviewReason, paymentReviewMessage, paymentReviewPage, type PaymentReviewItem } from "@/lib/billing/review";
export const item: PaymentReviewItem = {
  id: "operation", invoiceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", customerId: "customer", customerName: "Synthetic Client",
  jobId: "visit", amountCents: 19900, balanceCents: 21900, createdAt: "2026-10-25T15:00:00Z", expiresAt: "2026-10-25T15:02:00Z",
  channel: "checkout", state: "open", providerReference: "cs_SYNTHETIC", requestReference: "checkout:SYNTHETIC",
};
const now = "2026-10-25T16:00:00Z";
beforeEach(() => { vi.resetAllMocks(); m.profile.mockResolvedValue({ role: "admin" }); m.demo.mockReturnValue(false); m.list.mockResolvedValue({ items: [], total: 0 }); });
describe("office payment list", () => {
  it.each([null, { role: "customer" }, { role: "cleaner" }])("refuses %j before reading requests", async profile => {
    m.profile.mockResolvedValue(profile);
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow("not_found");
    expect(m.client).not.toHaveBeenCalled(); expect(m.list).not.toHaveBeenCalled();
  });
  it("shows load failure rather than a reassuring zero count", async () => {
    m.list.mockRejectedValue(new Error("unavailable"));
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('role="alert"'); expect(html).toContain("could not be loaded"); expect(html).not.toContain("0 unresolved");
  });
  it("distinguishes no pending requests from all invoices paid", () => {
    const html = renderToStaticMarkup(createElement(PaymentReviewList, { items: [], enabled: true, now }));
    expect(html).toContain("does not mean every invoice is paid");
  });
  it("renders request amount separately from changed balance and allows checking an existing reference", () => {
    const html = renderToStaticMarkup(createElement(PaymentReviewList, { items: [item], enabled: true, now }));
    expect(html).toContain("$199.00"); expect(html).toContain("current balance $219.00");
    expect(html).toContain("Check payment status"); expect(html).toContain("Still unresolved after the local deadline");
    expect(html).not.toContain("Charge now");
  });
  it.each([null, "abandoned"])("does not offer automatic release for missing/older receipt %s", state => {
    const row = state ? { ...item, state: "abandoned" as const } : { ...item, providerReference: null };
    const html = renderToStaticMarkup(createElement(PaymentReviewList, { items: [row], enabled: true, now }));
    expect(html).not.toContain("Check payment status"); expect(html).toContain("Find this request in Stripe");
    expect(html).toContain("does not confirm that it failed");
  });
  it.each([null, "abandoned"])("offers a confirmed manual release for missing/older receipt %s", state => {
    const row = state ? { ...item, state: "abandoned" as const } : { ...item, providerReference: null };
    const html = renderToStaticMarkup(createElement(PaymentReviewList, { items: [row], enabled: true, now }));
    expect(html).toContain("found no charge or payment");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Release request<\/button>/);
  });
  it("waits 30 minutes before offering to release a request with no receipt", () => {
    const row = { ...item, providerReference: null, createdAt: "2026-10-25T15:45:00Z" };
    const html = renderToStaticMarkup(createElement(PaymentReviewList, { items: [row], enabled: true, now }));
    expect(html).not.toContain("Release request"); expect(html).toContain("30 minutes after it started");
  });
  it("never offers release for a request a status check can answer", () => {
    const html = renderToStaticMarkup(createElement(PaymentReviewList, { items: [item], enabled: true, now }));
    expect(html).not.toContain("Release request");
  });
  it("keeps status checks inactive when billing is off", () => {
    const html = renderToStaticMarkup(createElement(PaymentReviewList, { items: [item], enabled: false, now }));
    expect(html).toContain('disabled=""');
  });
  it("does not label local expiry as provider failure", () => {
    expect(paymentReviewReason(item, new Date(now))).not.toContain("failed");
    expect(paymentReviewMessage({ state: "in_flight" })).toContain("still active");
    expect(paymentReviewMessage({ state: "cleared" })).toContain("review the current invoice");
  });
  it("bounds malformed pagination", () => {
    expect([undefined, "0", "-1", "Infinity", "1000000"].map(paymentReviewPage)).toEqual([1, 1, 1, 1, 1]);
    expect(paymentReviewPage("2")).toBe(2);
  });
});
