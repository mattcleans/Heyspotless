import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { InvoiceReviewChanged, issueServiceInvoice } from "@/lib/operations/invoice-issue-store";
import { isReviewId } from "@/lib/operations/visit-review";
import { toCalendarDate } from "@/lib/time/zone";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const reply = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store", vary: "Cookie" } });
export async function POST(request: NextRequest, context: {
    params: Promise<{
        id: string;
    }>;
}) {
    const repo = await getRepository();
    const profile = await repo.getCurrentProfile();
    if (!profile)
        return reply({ message: "Sign in to Management." }, 401);
    if (profile.role !== "admin")
        return reply({ message: "Management access is required." }, 403);
    if (repo.isDemo)
        return reply({ message: "Sample invoices cannot be issued." }, 503);
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin)
        return reply({ message: "Refresh this visit." }, 403);
    const { id } = await context.params;
    if (!isReviewId(id))
        return reply({ message: "Choose a valid visit." }, 400);
    let body: unknown;
    try {
        body = await request.json();
    }
    catch {
        return reply({ message: "Review the invoice first." }, 400);
    }
    const r = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const dueOn = toCalendarDate(r.dueOn);
    if (typeof r.invoiceId !== "string" || !isReviewId(r.invoiceId) || typeof r.reviewedTotalCents !== "number" || !Number.isSafeInteger(r.reviewedTotalCents) || r.reviewedTotalCents < 0 || r.reviewedTotalCents > 2147483647 || !dueOn || r.confirmed !== true)
        return reply({ message: "Review the exact invoice, amount and due date." }, 400);
    try {
        const job = await repo.getJob(id);
        if (!job)
            return reply({ message: "Visit not found." }, 404);
        const invoice = await repo.getInvoice(r.invoiceId);
        if (!invoice || invoice.jobId !== id || invoice.customerId !== job.customerId || invoice.kind !== "service")
            return reply({ message: "Service invoice not found." }, 404);
        const receipt = await issueServiceInvoice(createAdminClient(), id, r.invoiceId, profile.id, r.reviewedTotalCents, dueOn!);
        return reply(receipt);
    }
    catch (error) {
        return error instanceof InvoiceReviewChanged ? reply({ code: "review_changed", message: "The invoice or visit changed. Refresh and review it again." }, 409) : reply({ message: "Issuance could not be confirmed. Refresh the visit before trying again." }, 503);
    }
}
