import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { startSession, PaymentSessionError } from "./payment-session";
import { PaymentSessionNotice } from "./billing-actions";
import { CLIENT_REQUEST_TIMEOUT_MS } from "@/lib/http/fetch-with-timeout";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("payment recovery decisions", () => {
  it.each([
    [409, "payment_review_required", "office", "Call the office"],
    [503, "payment_review_required", "office", "Call the office"],
    [409, "bill_changed", "account", "Refresh Account"],
    [409, "payment_recorded", "account", "Refresh Account"],
    [409, "collection_in_flight", "account", "Refresh Account"],
    [401, "", "sign_in", "Sign in"],
  ])("offers recovery for HTTP %s %s", async (httpStatus, status, recovery, label) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status, message: "Review your payment." }, { status: httpStatus })));
    const error = await startSession("/api/billing/checkout", { invoiceId: "invoice", expectedBalanceCents: 19900 }).catch(e => e);
    expect(error).toBeInstanceOf(PaymentSessionError);
    expect(error.recovery).toBe(recovery);
    const html = renderToStaticMarkup(createElement(PaymentSessionNotice, { error }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(label);
    expect(html).toContain("min-h-11");
    if (recovery === "office") expect(html).toContain('href="tel:+14692800397"');
    if (recovery === "account") expect(html).toContain('href="/customer/account"');
    if (recovery === "sign_in") expect(html).toContain('href="/login?next=%2Fcustomer%2Faccount"');
  });

  it("preserves the reviewed balance and follows a confirmed existing session", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ url: "https://checkout.stripe.com/confirmed", reused: true }));
    vi.stubGlobal("fetch", fetch);
    await expect(startSession("/api/billing/checkout", { expectedBalanceCents: 19900 })).resolves.toBe("https://checkout.stripe.com/confirmed");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ expectedBalanceCents: 19900 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["network", "body", "missing_url"])("does not promise a failed or uncharged payment after %s uncertainty", async (failure) => {
    vi.stubGlobal("fetch", failure === "network" ? vi.fn().mockRejectedValue(new Error("offline"))
      : vi.fn().mockResolvedValue(failure === "body" ? new Response("<html>gateway</html>") : Response.json({})));
    await expect(startSession("/api/billing/checkout", {})).rejects.toMatchObject({ recovery: "account", message: expect.stringContaining("couldn’t confirm") });
  });

  it("bounds a stalled response body and never automatically submits twice", async () => {
    const fetch = vi.fn(async (_path, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })),
    }));
    vi.stubGlobal("fetch", fetch);
    const result = startSession("/api/billing/checkout", {}).catch(e => e);
    await vi.advanceTimersByTimeAsync(CLIENT_REQUEST_TIMEOUT_MS);
    expect(await result).toMatchObject({ recovery: "account", message: expect.stringContaining("couldn’t confirm") });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps server diagnostic errors out of an unavailable-payment notice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "internal provider diagnostic" }, { status: 500 })));
    await expect(startSession("/api/billing/checkout", {})).rejects.toMatchObject({ recovery: "office", message: "Online payment is unavailable. Call the office for help." });
  });
});
