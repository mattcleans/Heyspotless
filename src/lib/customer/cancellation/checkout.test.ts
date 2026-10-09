import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
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
  amounts: {
    subtotalCents: 6000,
    tipCents: 0,
    totalCents: 6000,
    amountPaidCents: 0,
    refundedCents: 0,
    creditCents: 0,
  },
};
function pay(tipCents = 0) {
  return POST(
    new NextRequest("https://example.test/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ invoiceId: "invoice", tipCents }),
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
  m.begin.mockResolvedValue({ outcome: "started" });
  m.ensure.mockResolvedValue("cus_existing");
  m.checkout.mockResolvedValue({
    id: "checkout",
    url: "https://checkout.example.test/fee",
  });
});
describe("canceled visit checkout", () => {
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
