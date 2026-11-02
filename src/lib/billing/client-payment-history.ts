import type { Invoice, Payment } from "../data/types";

export interface ClientPaymentReceipt {
  invoice: Invoice;
  payment: Payment;
}

/** Invoice issue dates and totals are not evidence of a payment. */
export async function loadClientPaymentHistory(
  repository: { listPayments(invoiceId: string): Promise<Payment[]> },
  invoices: readonly Invoice[],
) {
  const results = await Promise.allSettled(
    invoices.map(async (invoice) => ({
      invoice,
      payments: await repository.listPayments(invoice.id),
    })),
  );
  const receipts = new Map<string, ClientPaymentReceipt>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { invoice, payments } = result.value;
    for (const payment of payments) {
      if (payment.invoiceId !== invoice.id || payment.status !== "succeeded" || payment.amountCents <= 0) continue;
      receipts.set(payment.id, { invoice, payment });
    }
  }
  return {
    available: results.every((result) => result.status === "fulfilled"),
    receipts: [...receipts.values()].sort((a, b) =>
      (b.payment.succeededAt?.getTime() ?? 0) - (a.payment.succeededAt?.getTime() ?? 0)
      || a.payment.id.localeCompare(b.payment.id)),
  };
}
