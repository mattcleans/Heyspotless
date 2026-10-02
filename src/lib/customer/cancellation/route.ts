import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { isChoiceId } from "../cleaner-choice/input";
import {
  parseCancellation,
  toCancellationQuote,
  toCancellationReceipt,
} from "./types";
export function cancellationFailure(code?: string) {
  const status =
    code === "42501"
      ? 403
      : ["PT409", "40001", "40P01", "23514"].includes(code ?? "")
        ? 409
        : code === "22023"
          ? 400
          : 500;
  return NextResponse.json(
    {
      error:
        status === 403
          ? "This visit is no longer available to your account."
          : status === 409
            ? "The visit or cancellation fee changed. Review it again before confirming."
            : "We could not confirm the cancellation. Your visit may still be scheduled. Try again or call the office.",
    },
    { status },
  );
}
export async function cancelVisit(
  request: NextRequest,
  id: string,
  office: boolean,
) {
  const repo = await getRepository();
  if (repo.isDemo)
    return NextResponse.json(
      {
        error: "Preview changes cannot be saved. Sign in to cancel your visit.",
      },
      { status: 409 },
    );
  const profile = await repo.getCurrentProfile();
  if (!profile)
    return NextResponse.json(
      { error: "Sign in again to confirm this cancellation." },
      { status: 401 },
    );
  if (profile.role !== (office ? "admin" : "customer"))
    return NextResponse.json(
      { error: "Use the correct account to cancel this visit." },
      { status: 403 },
    );
  if (!isChoiceId(id))
    return NextResponse.json(
      { error: "Open a visit from your schedule." },
      { status: 400 },
    );
  const customer = office ? null : await repo.getCustomerByProfile(profile.id);
  if (!office && !customer)
    return NextResponse.json(
      { error: "Call the office to connect your account to your visits." },
      { status: 403 },
    );
  const job = await repo.getJob(id);
  if (!job || (!office && job.customerId !== customer!.id))
    return NextResponse.json(
      { error: "This visit is not available in your account." },
      { status: 404 },
    );
  let b;
  try {
    b = parseCancellation(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Review this cancellation." },
      { status: 400 },
    );
  }
  if (b.action === "review" && b.reason === "door_turnaway" && !office)
    return NextResponse.json(
      { error: "The office records door turnaways." },
      { status: 403 },
    );
  const db = await createClient();
  const { data, error } =
    b.action === "review"
      ? await db.rpc("quote_my_visit_cancellation", {
          p_job_id: id,
          p_reason: b.reason,
        })
      : await db.rpc("confirm_my_visit_cancellation", {
          p_job_id: id,
          p_quote_id: b.quoteId,
        });
  if (error) return cancellationFailure(error.code);
  try {
    const result =
      b.action === "review"
        ? toCancellationQuote(data)
        : toCancellationReceipt(data);
    if (
      result.jobId !== id ||
      (b.action === "confirm" && result.id !== b.quoteId) ||
      (b.action === "review" && result.reason !== b.reason)
    )
      return cancellationFailure();
    return NextResponse.json(
      b.action === "review"
        ? { quote: result }
        : { canceled: true, receipt: result },
    );
  } catch {
    return cancellationFailure();
  }
}
