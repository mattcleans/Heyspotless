/** A service draft awaiting office review is never a Client debt or Pay action. */
export function clientInvoiceGroups<T extends { status: string; balanceCents: number; voidedAt: Date | null }>(invoices: readonly T[]) {
  return {
    drafts: invoices.filter(i => i.status === "draft" && !i.voidedAt),
    outstanding: invoices.filter(i => (i.status === "sent" || i.status === "overdue") && i.balanceCents > 0 && !i.voidedAt),
    settled: invoices.filter(i => i.status !== "draft" && (i.balanceCents <= 0 || i.voidedAt)),
  };
}
