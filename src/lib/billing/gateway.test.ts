import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ session: vi.fn(), intent: vi.fn() }));
vi.mock("../stripe/client", () => ({ getStripe: () => ({ checkout: { sessions: { retrieve: m.session } }, paymentIntents: { retrieve: m.intent } }) }));
import { lookUpCheckoutSession, lookUpPaymentIntent } from "./gateway";
beforeEach(() => vi.resetAllMocks());
describe("provider payment certainty", () => {
  it("returns the actual active Checkout URL", async () => {
    m.session.mockResolvedValue({ status: "open", payment_status: "unpaid", url: "https://checkout.example.test/synthetic" });
    expect(await lookUpCheckoutSession("cs_synthetic")).toEqual({ state: "open", url: "https://checkout.example.test/synthetic" });
  });
  it("releases an explicitly expired session", async () => {
    m.session.mockResolvedValue({ status: "expired", payment_status: "unpaid" });
    expect(await lookUpCheckoutSession("cs_synthetic")).toEqual({ state: "dead", reason: "session expired" });
  });
  it("keeps completed unpaid Checkout blocked while its intent is processing", async () => {
    m.session.mockResolvedValue({ status: "complete", payment_status: "unpaid", payment_intent: "pi_synthetic" });
    m.intent.mockResolvedValue({ id: "pi_synthetic", status: "processing" });
    expect(await lookUpCheckoutSession("cs_synthetic")).toEqual({ state: "open", url: null });
  });
  it("does not invent a payment receipt when paid Checkout has no intent", async () => {
    m.session.mockResolvedValue({ status: "complete", payment_status: "paid", payment_intent: null, amount_total: 17000 });
    expect(await lookUpCheckoutSession("cs_synthetic")).toEqual({ state: "open", url: null });
  });
  it("keeps a confirmed Checkout tip attached to the captured amount", async () => {
    m.session.mockResolvedValue({
      status: "complete", payment_status: "paid", payment_intent: "pi_tip",
      amount_total: 19000, metadata: { tip_cents: "2000" },
    });
    expect(await lookUpCheckoutSession("cs_tip")).toEqual({
      state: "paid", paymentIntentId: "pi_tip", amountCents: 19000, tipCents: 2000, chargeId: null,
    });
  });
  it("preserves a delayed intent's tip", async () => {
    m.intent.mockResolvedValue({
      id: "pi_tip", status: "succeeded", amount_received: 19000, metadata: { tip_cents: "2000" },
    });
    expect(await lookUpPaymentIntent("pi_tip")).toMatchObject({ state: "paid", tipCents: 2000 });
  });
  it("keeps a payment with invalid tip evidence unresolved", async () => {
    m.intent.mockResolvedValue({
      id: "pi_tip", status: "succeeded", amount_received: 19000, metadata: { tip_cents: "19001" },
    });
    expect(await lookUpPaymentIntent("pi_tip")).toEqual({ state: "open", url: null });
  });
  it("keeps an unknown future intent state unresolved", async () => {
    m.intent.mockResolvedValue({ id: "pi_synthetic", status: "unknown_future_state" });
    expect(await lookUpPaymentIntent("pi_synthetic")).toEqual({ state: "open", url: null });
  });
  it.each(["canceled", "requires_payment_method"])("releases a confirmed %s intent", async status => {
    m.session.mockResolvedValue({ status: "complete", payment_status: "unpaid", payment_intent: "pi_synthetic" });
    m.intent.mockResolvedValue({ id: "pi_synthetic", status });
    expect(await lookUpCheckoutSession("cs_synthetic")).toEqual({ state: "dead", reason: `payment intent ${status}` });
  });
  it("recovers a settled delayed intent with its immutable receipt and received amount", async () => {
    m.session.mockResolvedValue({ status: "complete", payment_status: "unpaid", payment_intent: { id: "pi_synthetic" } });
    m.intent.mockResolvedValue({ id: "pi_synthetic", status: "succeeded", amount: 18000, amount_received: 17000, latest_charge: "ch_synthetic" });
    expect(await lookUpCheckoutSession("cs_synthetic")).toEqual({ state: "paid", paymentIntentId: "pi_synthetic", amountCents: 17000, tipCents: 0, chargeId: "ch_synthetic" });
  });
  it.each([null, 0, -1, 1.5])("does not invent received money from a succeeded intent with amount %s", async amount_received => {
    m.intent.mockResolvedValue({ id: "pi_synthetic", status: "succeeded", amount: 17000, amount_received });
    expect(await lookUpPaymentIntent("pi_synthetic")).toEqual({ state: "open", url: null });
  });
  it("keeps a completed session without an intent unresolved", async () => {
    m.session.mockResolvedValue({ status: "complete", payment_status: "unpaid", payment_intent: null });
    expect(await lookUpCheckoutSession("cs_synthetic")).toEqual({ state: "open", url: null });
  });
  it("retains uncertainty when the attached intent lookup fails", async () => {
    m.session.mockResolvedValue({ status: "complete", payment_status: "unpaid", payment_intent: "pi_synthetic" });
    m.intent.mockRejectedValue(new Error("provider unavailable"));
    await expect(lookUpCheckoutSession("cs_synthetic")).rejects.toThrow("provider unavailable");
  });
});
