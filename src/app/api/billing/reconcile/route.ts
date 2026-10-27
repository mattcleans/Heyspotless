import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { reconcileInvoiceCollection } from "@/lib/billing/collection";
import { paymentReviewMessage } from "@/lib/billing/review";
import { isBillingEnabled } from "@/lib/stripe/env";
import { isDemoMode } from "@/lib/supabase/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Checks existing provider objects; never creates a charge, refund or session. */
export async function POST(request: NextRequest) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ message: "Sign in to Management." }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ message: "Management access is required." }, { status: 403 });
  if (isDemoMode() || !isBillingEnabled()) return NextResponse.json({ message: "Payment status checks are inactive in this deployment." }, { status: 503 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ message: "Choose an invoice to check." }, { status: 400 }); }
  const invoiceId = body && typeof body === "object" && "invoiceId" in body ? body.invoiceId : null;
  if (typeof invoiceId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(invoiceId)) {
    return NextResponse.json({ message: "Choose a valid invoice to check." }, { status: 400 });
  }
  // Read through the user's repository before creating a privileged writer.
  if (!await repo.getInvoice(invoiceId)) return NextResponse.json({ message: "Invoice not found." }, { status: 404 });
  try {
    const result = await reconcileInvoiceCollection(new BillingStore(createAdminClient()), invoiceId);
    return NextResponse.json({ state: result.state, reviewRequired: result.reviewRequired === true, message: paymentReviewMessage(result) });
  } catch {
    return NextResponse.json({ message: "Payment status could not be confirmed. Refresh before arranging another payment." }, { status: 503 });
  }
}
