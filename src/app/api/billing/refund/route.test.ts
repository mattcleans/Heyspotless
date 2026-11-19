import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  profile: vi.fn(),
  admin: vi.fn(),
  billing: vi.fn(),
  payment: vi.fn(),
  record: vi.fn(),
  refund: vi.fn(),
}));
vi.mock("@/lib/data", () => ({ getRepository: async () => ({ getCurrentProfile: m.profile }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
vi.mock("@/lib/stripe/env", () => ({ isBillingEnabled: m.billing }));
vi.mock("@/lib/billing/store", () => ({
  BillingStore: class {
    paymentForIntent = m.payment;
    recordRefund = m.record;
  },
}));
vi.mock("@/lib/billing/gateway", () => ({ refundPaymentIntent: m.refund }));

import { POST } from "./route";

const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const valid = { paymentIntentId: "pi_1", amountCents: 500, kind: "goodwill", reason: " Late arrival ", requestId };
const request = (body: unknown = valid, headers: Record<string, string> = {}) =>
  new NextRequest("https://example.test/api/billing/refund", { method: "POST", body: JSON.stringify(body), headers });

function payment(overrides: Record<string, unknown> = {}) {
  return { id: "pay_1", invoiceId: "inv_1", amountCents: 1000, status: "succeeded", stripePaymentIntentId: "pi_1", paidAt: null, refunds: [], refundableCents: 1000, ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();
  m.billing.mockReturnValue(true);
  m.profile.mockResolvedValue({ id: "staff", role: "admin" });
  m.payment.mockResolvedValue(payment());
  m.refund.mockResolvedValue({ id: "re_1", status: "succeeded" });
  m.record.mockResolvedValue("refund_row_1");
});

describe("refunding from Management", () => {
  it("is unavailable while billing is off", async () => {
    m.billing.mockReturnValue(false);
    expect((await POST(request())).status).toBe(503);
    expect(m.refund).not.toHaveBeenCalled();
  });

  it.each([[null, 401], [{ id: "client", role: "customer" }, 403], [{ id: "cleaner", role: "cleaner" }, 403]])(
    "refuses %j before any privileged work",
    async (profile, status) => {
      m.profile.mockResolvedValue(profile);
      expect((await POST(request())).status).toBe(status);
      expect(m.admin).not.toHaveBeenCalled();
      expect(m.refund).not.toHaveBeenCalled();
    },
  );

  it("refuses a cross-site request", async () => {
    expect((await POST(request(valid, { origin: "https://elsewhere.test" }))).status).toBe(403);
    expect(m.refund).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...valid, paymentIntentId: undefined }],
    [{ ...valid, amountCents: 0 }],
    [{ ...valid, amountCents: -100 }],
    [{ ...valid, amountCents: 12.5 }],
    [{ ...valid, amountCents: "500" }],
    [{ ...valid, kind: undefined }],
    [{ ...valid, kind: "because" }],
    [{ ...valid, requestId: undefined }],
    [{ ...valid, requestId: "not-a-uuid" }],
  ])("refuses an incomplete request %j", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(m.refund).not.toHaveBeenCalled();
  });

  it("refuses a payment it does not know", async () => {
    m.payment.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(404);
    expect(m.refund).not.toHaveBeenCalled();
  });

  it("refuses a payment that did not complete", async () => {
    m.payment.mockResolvedValue(payment({ status: "processing", refundableCents: 0 }));
    expect((await POST(request())).status).toBe(409);
    expect(m.refund).not.toHaveBeenCalled();
  });

  it("refuses more than is still refundable, and says how much is", async () => {
    m.payment.mockResolvedValue(payment({ refundableCents: 300 }));
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("$3.00");
    expect(m.refund).not.toHaveBeenCalled();
  });

  it("says when a payment has already been refunded in full", async () => {
    m.payment.mockResolvedValue(payment({ refundableCents: 0 }));
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already been refunded in full/);
  });

  it("refunds once per submitted form, with the reason travelling to Stripe", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(m.refund).toHaveBeenCalledWith({
      paymentIntentId: "pi_1",
      amountCents: 500,
      reason: "Late arrival",
      kind: "goodwill",
      idempotencyKey: `refund:pi_1:${requestId}`,
    });
    expect(m.record).toHaveBeenCalledWith(expect.objectContaining({
      stripePaymentIntentId: "pi_1", amountCents: 500, kind: "goodwill", status: "succeeded",
      stripeRefundId: "re_1", requestedBy: "staff", reason: "Late arrival",
    }));
  });

  it("records a refund Stripe has not finished as pending", async () => {
    m.refund.mockResolvedValue({ id: "re_1", status: "pending" });
    await POST(request());
    expect(m.record).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  });

  it("explains a definite Stripe refusal", async () => {
    m.refund.mockRejectedValue(Object.assign(new Error("Charge has already been refunded."), { type: "StripeInvalidRequestError", statusCode: 400 }));
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("already been refunded");
    expect(m.record).not.toHaveBeenCalled();
  });

  it("treats an unanswered Stripe call as unknown, safe to retry from the same form", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    m.refund.mockRejectedValue(Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" }));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ retrySafe: true });
    expect(m.record).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("warns against refunding again when Stripe refunded but saving failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    m.record.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ refunded: true, stripeRefundId: "re_1" });
    expect(body.error).toMatch(/Do not refund again/);
    expect(JSON.stringify(body)).not.toContain("database unavailable");
    error.mockRestore();
  });
});
