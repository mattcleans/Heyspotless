import { isReviewId } from "./visit-review";
import { toCalendarDate } from "@/lib/time/zone";
export interface InvoiceIssueReceipt {
    issued: true;
    visitId: string;
    invoiceId: string;
    totalCents: number;
    dueOn: string;
    issuedAt: string;
}
export function readIssueReceipt(value: unknown, expected: {
    visitId: string;
    invoiceId: string;
    totalCents: number;
    dueOn: string;
}): InvoiceIssueReceipt | null {
    if (!value || typeof value !== "object")
        return null;
    const r = value as Record<string, unknown>;
    if (r.issued !== true || r.visitId !== expected.visitId || r.invoiceId !== expected.invoiceId || !isReviewId(expected.visitId) || !isReviewId(expected.invoiceId) || r.totalCents !== expected.totalCents || !Number.isSafeInteger(r.totalCents) || Number(r.totalCents) < 0 || r.dueOn !== expected.dueOn || !toCalendarDate(r.dueOn) || typeof r.issuedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(r.issuedAt) || !Number.isFinite(Date.parse(r.issuedAt)))
        return null;
    return r as unknown as InvoiceIssueReceipt;
}
