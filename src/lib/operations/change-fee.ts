import { isReviewId } from "./visit-review";
import { readIssueReceipt, type InvoiceIssueReceipt } from "./invoice-issue";
export type ChangeFeeKind = "cancellation_fee" | "reschedule_fee";
export const isChangeFeeKind = (value: unknown): value is ChangeFeeKind => value === "cancellation_fee" || value === "reschedule_fee";
export const changeFeeLabel = (kind: ChangeFeeKind) => kind === "cancellation_fee" ? "Cancellation fee" : "Rescheduling fee";
export interface ChangeFeeReview {
  invoiceId: string; changeId: string; visitId: string; customerId: string;
  customerName: string; kind: ChangeFeeKind; totalCents: number; dueOn: string | null;
  issuedAt: string | null; status: string; changedAt: string;
}
export interface ChangeFeeReceipt extends InvoiceIssueReceipt { kind: ChangeFeeKind; changeId: string; }
export function readChangeFeeReceipt(value: unknown, expected: Pick<ChangeFeeReview,"visitId"|"invoiceId"|"changeId"|"kind"|"totalCents"> & {dueOn:string}): ChangeFeeReceipt | null {
  const base=readIssueReceipt(value,expected);
  const r=value as Record<string,unknown> | null;
  return base && isReviewId(expected.changeId) && isChangeFeeKind(expected.kind) && r?.changeId===expected.changeId && r.kind===expected.kind ? r as unknown as ChangeFeeReceipt : null;
}
