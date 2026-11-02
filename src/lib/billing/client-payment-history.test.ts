import { describe, expect, it } from "vitest";
import type { Invoice, Payment } from "../data/types";
import { loadClientPaymentHistory } from "./client-payment-history";

const invoice = (id: string) => ({ id, issuedAt: new Date("2026-10-29T21:20:00Z") }) as Invoice;
const payment = (id: string, invoiceId: string, overrides: Partial<Payment> = {}): Payment => ({
  id, invoiceId, amountCents: 19900, status: "succeeded", method: "card", isAutocharge: false,
  failureMessage: null, succeededAt: new Date("2026-11-02T16:31:07Z"),
  createdAt: new Date("2026-11-02T16:30:00Z"), ...overrides,
});

describe("Client payment receipts", () => {
  it("uses the confirmed payment date and partial amount rather than invoice terms", async () => {
    const paid = payment("paid", "invoice", { amountCents: 6000 });
    const history = await loadClientPaymentHistory({ listPayments: async () => [paid] }, [invoice("invoice")]);
    expect(history.available).toBe(true);
    expect(history.receipts[0]?.payment.amountCents).toBe(6000);
    expect(history.receipts[0]?.payment.succeededAt?.toISOString()).toBe("2026-11-02T16:31:07.000Z");
    expect(history.receipts[0]?.invoice.issuedAt?.toISOString()).toBe("2026-10-29T21:20:00.000Z");
  });
  it("excludes failed, pending, foreign-invoice and zero-value records", async () => {
    const records = [payment("failed", "i", { status: "failed" }), payment("pending", "i", { status: "processing" }),
      payment("foreign", "other"), payment("zero", "i", { amountCents: 0 })];
    expect((await loadClientPaymentHistory({ listPayments: async () => records }, [invoice("i")])).receipts).toEqual([]);
  });
  it("keeps successful payments on outstanding or voided invoices and does not invent a missing date", async () => {
    const paid = payment("paid", "i", { succeededAt: null });
    const history = await loadClientPaymentHistory({ listPayments: async () => [paid, paid] }, [invoice("i")]);
    expect(history.receipts).toHaveLength(1);
    expect(history.receipts[0]?.payment.succeededAt).toBeNull();
  });
  it("does not let one failed history lookup hide account balances or other receipts", async () => {
    const history = await loadClientPaymentHistory({ listPayments: async (id) => {
      if (id === "unavailable") throw new Error("database unavailable");
      return [payment("paid", id)];
    } }, [invoice("ok"), invoice("unavailable")]);
    expect(history.available).toBe(false);
    expect(history.receipts.map((r) => r.payment.id)).toEqual(["paid"]);
  });
  it("orders by confirmed payment time rather than invoice or attempt creation", async () => {
    const records = [payment("older", "i", { succeededAt: new Date("2026-10-31T12:00:00Z") }), payment("newer", "i")];
    const history = await loadClientPaymentHistory({ listPayments: async () => records }, [invoice("i")]);
    expect(history.receipts.map((r) => r.payment.id)).toEqual(["newer", "older"]);
  });
});
