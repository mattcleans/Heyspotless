import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BillChangedError } from "@/lib/billing/types";
const m = vi.hoisted(() => ({
  repo: vi.fn(),
  client: vi.fn(),
  cancel: vi.fn(),
  admin: vi.fn(),
  reconcile: vi.fn(),
  checkout: vi.fn(),
  ensure: vi.fn(),
  begin: vi.fn(),
  attach: vi.fn(),
  session: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: m.repo }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("./store", () => ({ loadCancellation: m.cancel }));
vi.mock("@/lib/billing/store", () => ({
  BillingStore: class {
    beginPaymentOperation = m.begin;
    attachPaymentOperation = m.attach;
    setCheckoutSession = m.session;
    resolvePaymentOperation = m.resolve;
  },
}));
vi.mock("@/lib/billing/collection", () => ({
  checkoutKeyFor: () => "key",
  reconcileInvoiceCollection: m.reconcile,
}));
vi.mock("@/lib/billing/gateway", () => ({
  createCheckoutSession: m.checkout,
  ensureStripeCustomer: m.ensure,
}));
vi.mock("@/lib/stripe/env", () => ({ isBillingEnabled: () => true }));
import { POST } from "@/app/api/billing/checkout/route";
const invoice = {
  id: "invoice",
  jobId: "job",
  customerId: "customer",
  balanceCents: 6000,
  status: "sent",
  amounts: {
    subtotalCents: 6000,
    tipCents: 0,
    totalCents: 6000,
    amountPaidCents: 0,
    refundedCents: 0,
    creditCents: 0,
  },
};
function pay(tipCents = 0, expectedBalanceCents = 6000) {
  return POST(
    new NextRequest("https://example.test/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ invoiceId: "invoice", tipCents, expectedBalanceCents }),
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  m.repo.mockResolvedValue({
    getCurrentProfile: async () => ({ id: "profile", role: "customer" }),
    getInvoice: async () => invoice,
    getCustomer: async () => ({
      id: "customer",
      stripeCustomerId: "cus_existing",
    }),
    getJob: async () => ({ id: "job", status: "canceled" }),
  });
  m.client.mockResolvedValue({});
  m.cancel.mockResolvedValue({ billingReview: false, invoiceId: "invoice" });
  m.reconcile.mockResolvedValue({ state: "cleared" });
  m.begin.mockResolvedValue({ outcome: "started", idempotencyKey: "key" });
  m.ensure.mockResolvedValue("cus_existing");
  m.checkout.mockResolvedValue({
    id: "checkout",
    url: "https://checkout.example.test/fee",
  });
});
describe("canceled visit checkout", () => {
  it("uses the server's fresh retry key for the provider and attachment", async () => {
    m.begin.mockResolvedValue({ outcome: "started", idempotencyKey: "key:retry:confirmed-old-id" });
    await pay();
    expect(m.checkout).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "key:retry:confirmed-old-id" }));
    expect(m.attach).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "key:retry:confirmed-old-id" }));
  });
  it("keeps an unconfirmed creation request open for review instead of releasing it", async () => {
    m.checkout.mockRejectedValue(new Error("network response lost"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await pay();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "payment_review_required" });
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.attach).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it("does not resume a stored URL when the provider outcome is unconfirmed", async () => {
    m.reconcile.mockResolvedValue({ state: "in_flight", reviewRequired: true, redirectUrl: "https://checkout.example.test/stored", operation: { channel: "checkout", amountCents: 6000 } });
    const response = await pay();
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("url");
    expect(m.begin).not.toHaveBeenCalled();
  });
  it("does not resume an existing Checkout page for a different current amount", async () => {
    m.reconcile.mockResolvedValue({ state: "in_flight", redirectUrl: "https://checkout.example.test/old", operation: { channel: "checkout", amountCents: 7000 } });
    const response = await pay();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "payment_review_required" });
    expect(m.begin).not.toHaveBeenCalled();
  });
  it("resumes a provider-confirmed active page only for the same reviewed bill", async () => {
    m.reconcile.mockResolvedValue({ state: "in_flight", redirectUrl: "https://checkout.example.test/current", operation: { channel: "checkout", amountCents: 6000 } });
    const response = await pay();
    expect(await response.json()).toEqual({ url: "https://checkout.example.test/current", reused: true });
    expect(m.checkout).not.toHaveBeenCalled();
  });
  it("does not claim the entire bill is paid after recovering a single payment", async () => {
    m.reconcile.mockResolvedValue({ state: "settled", recoveredPayment: true });
    const response = await pay();
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("latest balance") });
    expect(m.begin).not.toHaveBeenCalled();
  });
  it("binds a new checkout to the balance displayed on the Client's Pay button", async () => {
    const response = await pay(0, 5000);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "bill_changed", message: expect.stringContaining("Refresh Account") });
    expect(m.begin).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });
  it("asks an older form with no reviewed balance to refresh before billing work", async () => {
    const response = await POST(new NextRequest("https://example.test/api/billing/checkout", { method: "POST", body: JSON.stringify({ invoiceId: "invoice" }) }));
    expect(response.status).toBe(409);
    expect(m.repo).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });
  it("requests a new balance review before any provider call when the claim is stale", async () => {
    m.begin.mockRejectedValue(new BillChangedError());
    const response = await pay();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "bill_changed", message: expect.stringContaining("Refresh Account") });
    expect(m.ensure).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
    expect(m.attach).not.toHaveBeenCalled();
  });
  it("does not fall back to a stale invoice when its fresh read disappears", async () => {
    const getInvoice = vi.fn().mockResolvedValueOnce(invoice).mockResolvedValueOnce(null);
    m.repo.mockResolvedValue({
      getCurrentProfile: async () => ({ id: "profile", role: "customer" }), getInvoice,
      getCustomer: async () => ({ id: "customer", stripeCustomerId: "cus_existing" }),
      getJob: async () => ({ id: "job", status: "canceled" }),
    });
    expect((await pay()).status).toBe(409);
    expect(m.begin).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });
  it.each([-1, 1.5, "2000", null, 2147483648])("rejects malformed tips %j before billing work", async tipCents => {
    const response = await POST(new NextRequest("https://example.test/api/billing/checkout", { method: "POST", body: JSON.stringify({ invoiceId: "invoice", tipCents }) }));
    expect(response.status).toBe(400);
    expect(m.repo).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });
  function reschedulingInvoice() {
    m.repo.mockResolvedValue({
      getCurrentProfile: async () => ({ id: "profile", role: "customer" }),
      getInvoice: async () => ({
        ...invoice,
        jobId: null,
        kind: "reschedule_fee",
      }),
      getCustomer: async () => ({
        id: "customer",
        stripeCustomerId: "cus_existing",
      }),
    });
  }
  it("collects a separate rescheduling fee with its own label and lock", async () => {
    reschedulingInvoice();
    expect((await pay()).status).toBe(200);
    expect(m.cancel).not.toHaveBeenCalled();
    expect(m.begin).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "invoice", amountCents: 6000 }),
    );
    expect(m.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        tipCents: 0,
        description: "Hey Spotless · rescheduling fee",
      }),
    );
  });
  it("refuses cleaner tips on rescheduling fee checkout", async () => {
    reschedulingInvoice();
    expect((await pay(1000)).status).toBe(400);
    expect(m.reconcile).not.toHaveBeenCalled();
    expect(m.checkout).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { billingReview: true, invoiceId: null },
    { billingReview: false, invoiceId: "different" },
  ])(
    "blocks old service balance and in-flight redirects for %j",
    async (cancellation) => {
      m.cancel.mockResolvedValue(cancellation);
      expect((await pay()).status).toBe(409);
      expect(m.reconcile).not.toHaveBeenCalled();
      expect(m.admin).not.toHaveBeenCalled();
      expect(m.checkout).not.toHaveBeenCalled();
    },
  );
  it("fails closed if the cancellation ledger is unavailable", async () => {
    m.cancel.mockRejectedValue(new Error("private detail"));
    const r = await pay();
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toContain("private detail");
    expect(m.admin).not.toHaveBeenCalled();
  });
  it("does not add a cleaner tip to a cancellation fee", async () => {
    expect((await pay(1000)).status).toBe(400);
    expect(m.checkout).not.toHaveBeenCalled();
  });
  it("uses the normal collection lock for the exact fee invoice and labels the charge", async () => {
    const r = await pay();
    expect(r.status).toBe(200);
    expect(m.begin).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "invoice", amountCents: 6000 }),
    );
    expect(m.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 6000,
        tipCents: 0,
        description: "Hey Spotless · cancellation fee",
      }),
    );
    expect(await r.json()).toEqual({
      url: "https://checkout.example.test/fee",
    });
  });
});
