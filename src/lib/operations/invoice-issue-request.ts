import { fetchWithTimeout } from "@/lib/http/fetch-with-timeout";
import { readIssueReceipt, type InvoiceIssueReceipt } from "./invoice-issue";
export type IssueResult = {
    confirmed: true;
    receipt: InvoiceIssueReceipt;
} | {
    confirmed: false;
    signIn: boolean;
    message: string;
};
export async function requestInvoiceIssue(visitId: string, invoiceId: string, totalCents: number, dueOn: string): Promise<IssueResult> {
    try {
        const response = await fetchWithTimeout(`/api/admin/visits/${visitId}/invoice-issue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoiceId, reviewedTotalCents: totalCents, dueOn, confirmed: true }) });
        const value: unknown = await response.json();
        if (!response.ok) {
            const r = value && typeof value === "object" ? value as Record<string, unknown> : {};
            return { confirmed: false, signIn: response.status === 401, message: response.status === 401 ? "Sign in to Management and reopen this invoice." : response.status === 409 && r.code === "review_changed" ? "The invoice or visit changed. Refresh and review it again." : "Issuance could not be confirmed. Refresh the visit before trying again." };
        }
        const receipt = readIssueReceipt(value, { visitId, invoiceId, totalCents, dueOn });
        if (!receipt)
            throw new Error("Unconfirmed receipt");
        return { confirmed: true, receipt };
    }
    catch {
        return { confirmed: false, signIn: false, message: "Issuance could not be confirmed. Refresh the visit before trying again." };
    }
}
