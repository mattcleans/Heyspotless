import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { DraftPriceChanged, prepareServiceDraft } from "@/lib/operations/invoice-draft-store";
import { isReviewId } from "@/lib/operations/visit-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const reply = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store", vary: "Cookie" } });

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return reply({ message: "Sign in to Management before preparing a draft." }, 401);
  if (profile.role !== "admin") return reply({ message: "Management access is required." }, 403);
  if (repo.isDemo) return reply({ message: "Sample visits cannot create invoice drafts." }, 503);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return reply({ message: "Refresh this visit before preparing a draft." }, 403);
  const { id } = await context.params;
  if (!isReviewId(id)) return reply({ message: "Choose a valid visit." }, 400);
  let body: unknown;
  try { body = await request.json(); } catch { return reply({ message: "Review the visit price before preparing a draft." }, 400); }
  const price = body && typeof body === "object" && "reviewedPriceCents" in body ? body.reviewedPriceCents : null;
  if (typeof price !== "number" || !Number.isSafeInteger(price) || price < 0 || price > 2147483647) return reply({ message: "Review a valid visit price before preparing a draft." }, 400);
  try {
    // Read through the signed-in user's repository before creating a writer.
    const job = await repo.getJob(id);
    if (!job) return reply({ message: "Visit not found." }, 404);
    if (job.status !== "complete") return reply({ message: "The visit must be complete before its service draft can be prepared." }, 409);
    const invoiceId = await prepareServiceDraft(createAdminClient(), id, price);
    if (!invoiceId || !isReviewId(invoiceId)) return reply({ message: "A service draft was not confirmed. Refresh the visit and review its saved photos, price and invoice records." }, 409);
    const invoice = await repo.getInvoice(invoiceId);
    if (!invoice || invoice.jobId !== id || invoice.customerId !== job.customerId || invoice.kind !== "service" || invoice.status === "void" || invoice.voidedAt || !Number.isSafeInteger(invoice.amounts.totalCents) || invoice.amounts.totalCents < 0) {
      return reply({ message: "The invoice record could not be confirmed. Refresh this visit before trying again." }, 503);
    }
    return reply({ confirmed: true, visitId: id, invoiceId, status: invoice.status, totalCents: invoice.amounts.totalCents,
      message: invoice.status === "draft" ? "Service draft ready. No payment was taken." : "Existing service invoice confirmed. No new payment was taken." });
  } catch (error) {
    return error instanceof DraftPriceChanged
      ? reply({ message: "The visit price changed. Refresh and review the new price before preparing a draft." }, 409)
      : reply({ message: "The draft status could not be confirmed. Refresh this visit before trying again." }, 503);
  }
}
