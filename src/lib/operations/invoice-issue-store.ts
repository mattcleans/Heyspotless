import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readIssueReceipt } from "./invoice-issue";
export class InvoiceReviewChanged extends Error {
}
export async function issueServiceInvoice(db: SupabaseClient, visitId: string, invoiceId: string, actorId: string, totalCents: number, dueOn: string) {
    const { data, error } = await db.rpc("issue_reviewed_service_invoice", { p_job: visitId, p_invoice: invoiceId, p_actor: actorId, p_reviewed_total: totalCents, p_due: dueOn });
    if (error?.code === "PIS01")
        throw new InvoiceReviewChanged();
    if (error)
        throw new Error("Invoice issuance could not be confirmed.");
    const receipt = readIssueReceipt(data, { visitId, invoiceId, totalCents, dueOn });
    if (!receipt)
        throw new Error("Invoice issuance could not be confirmed.");
    return receipt;
}
