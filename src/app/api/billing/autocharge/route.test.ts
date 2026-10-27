import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BillChangedError } from "@/lib/billing/types";
const m = vi.hoisted(() => ({ begin: vi.fn(), attach: vi.fn(), charge: vi.fn(), plan: vi.fn(), failure: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/billing/store", () => ({ BillingStore: class {
  listAutochargeCandidates = async () => [];
  getStripeCustomerId = async () => "cus_synthetic";
  beginPaymentOperation = m.begin;
  attachPaymentOperation = m.attach;
  recordAutochargeFailure = m.failure;
} }));
vi.mock("@/lib/billing/autocharge", () => ({ planSweep: m.plan, nextAttemptAfter: vi.fn() }));
vi.mock("@/lib/billing/gateway", () => ({ chargeOffSession: m.charge }));
vi.mock("@/lib/stripe/env", () => ({ cronSecretMatches: () => true, isBillingEnabled: () => true }));
import { POST } from "./route";
const decision = (id: string) => ({ action: "charge", invoiceId: id, customerId: "customer", amountCents: 17000, paymentMethodId: "pm_synthetic", attempt: 1, idempotencyKey: `SYNTHETIC-${id}` });
beforeEach(() => {
  vi.resetAllMocks();
  m.attach.mockResolvedValue(true);
  m.charge.mockResolvedValue({ status: "processing", paymentIntentId: "pi_synthetic" });
});
describe("sweep bill changes", () => {
  it("skips a changed bill without spending a card attempt and continues the sweep", async () => {
    m.plan.mockReturnValue([decision("changed"), decision("current")]);
    m.begin.mockRejectedValueOnce(new BillChangedError()).mockResolvedValueOnce({ outcome: "started" });
    const response = await POST(new NextRequest("https://example.test/api/billing/autocharge", { method: "POST" }));
    expect(await response.json()).toMatchObject({ swept: 2, skipped: 1, failed: 0, unresolved: 1 });
    expect(m.begin).toHaveBeenNthCalledWith(1, expect.objectContaining({ invoiceId: "changed", expectedBalanceCents: 17000, expectedCustomerId: "customer" }));
    expect(m.charge).toHaveBeenCalledOnce();
    expect(m.charge).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: "current" }));
    expect(m.failure).not.toHaveBeenCalled();
  });
  it("does not turn an unrelated database failure into a successful skip", async () => {
    m.plan.mockReturnValue([decision("broken")]);
    m.begin.mockRejectedValue(new Error("database unavailable"));
    await expect(POST(new NextRequest("https://example.test/api/billing/autocharge", { method: "POST" }))).rejects.toThrow("database unavailable");
    expect(m.charge).not.toHaveBeenCalled();
    expect(m.failure).not.toHaveBeenCalled();
  });
});
