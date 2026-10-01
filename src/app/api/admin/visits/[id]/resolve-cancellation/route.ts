import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { reconcileInvoiceCollection } from "@/lib/billing/collection";
import { isChoiceId } from "@/lib/customer/cleaner-choice/input";
import { loadCancellation } from "@/lib/customer/cancellation/store";
import { toCancellationReceipt } from "@/lib/customer/cancellation/types";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const repo = await getRepository();
  if (repo.isDemo)
    return NextResponse.json(
      { error: "Preview billing cannot be changed." },
      { status: 409 },
    );
  const profile = await repo.getCurrentProfile();
  if (!profile)
    return NextResponse.json(
      { error: "Sign in again to review cancellation billing." },
      { status: 401 },
    );
  if (profile.role !== "admin")
    return NextResponse.json(
      { error: "Use your office account." },
      { status: 403 },
    );
  const { id } = await params;
  let cancellationId: unknown;
  try {
    cancellationId = (await request.json()).cancellationId;
  } catch {}
  if (!isChoiceId(id) || !isChoiceId(cancellationId))
    return NextResponse.json(
      { error: "Open the current cancellation record." },
      { status: 400 },
    );
  const job = await repo.getJob(id);
  if (!job)
    return NextResponse.json({ error: "Visit unavailable." }, { status: 404 });
  const db = await createClient();
  try {
    const current = await loadCancellation(db, id);
    if (!current || current.id !== cancellationId)
      return NextResponse.json(
        { error: "Refresh the cancellation record." },
        { status: 409 },
      );
    if (current.billingReview) {
      const { data, error } = await db
        .from("invoices")
        .select("id")
        .eq("job_id", id)
        .order("id")
        .limit(200);
      if (error || !Array.isArray(data) || data.some((r) => !isChoiceId(r.id)))
        throw new Error("Invoice records unavailable.");
      const store = new BillingStore(createAdminClient());
      for (const invoice of data) {
        const outcome = await reconcileInvoiceCollection(store, invoice.id);
        if (outcome.state === "in_flight")
          return NextResponse.json(
            {
              error:
                "A payment is still in progress. Review it with the payment provider before settling this cancellation.",
            },
            { status: 409 },
          );
      }
    }
    const { data, error } = await db.rpc("resolve_visit_cancellation_billing", {
      p_job_id: id,
      p_cancellation_id: cancellationId,
    });
    if (error)
      return NextResponse.json(
        {
          error:
            error.code === "40001"
              ? "Existing payments must be fully refunded and pending attempts or refunds resolved before the cancellation fee can be invoiced."
              : "Cancellation billing could not be confirmed. Refresh and check the payment records.",
        },
        {
          status:
            error.code === "40001" ? 409 : error.code === "42501" ? 403 : 500,
        },
      );
    const receipt = toCancellationReceipt(data);
    if (
      receipt.id !== cancellationId ||
      receipt.jobId !== id ||
      receipt.billingReview
    )
      throw new Error("Unconfirmed result.");
    return NextResponse.json({ resolved: true, receipt });
  } catch {
    return NextResponse.json(
      {
        error:
          "Cancellation billing could not be confirmed. Check the payment records and try again.",
      },
      { status: 503 },
    );
  }
}
