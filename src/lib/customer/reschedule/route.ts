import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { isChoiceId } from "../cleaner-choice/input";
import {
  parseReschedule,
  toRescheduleQuote,
  toRescheduleReceipt,
} from "./types";
export async function rescheduleVisit(
  request: NextRequest,
  id: string,
  office: boolean,
) {
  const repo = await getRepository();
  if (repo.isDemo)
    return NextResponse.json(
      { error: "Preview only. Sign in to move a real visit." },
      { status: 409 },
    );
  const profile = await repo.getCurrentProfile();
  if (!profile)
    return NextResponse.json(
      { error: "Sign in again to save the new appointment." },
      { status: 401 },
    );
  if (profile.role !== (office ? "admin" : "customer"))
    return NextResponse.json(
      { error: "Use the correct account to manage this visit." },
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
    b = parseReschedule(await request.json());
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "Review the new appointment time.",
      },
      { status: 400 },
    );
  }
  const db = await createClient();
  const { data, error } =
    b.action === "review"
      ? await db.rpc("quote_my_visit_reschedule_with_fee", {
          p_job_id: id,
          p_new_start: b.newStart,
        })
      : await db.rpc("confirm_my_visit_reschedule", {
          p_job_id: id,
          p_quote_id: b.quoteId,
        });
  if (error) return failure(error.code);
  try {
    const result =
      b.action === "review"
        ? toRescheduleQuote(data)
        : toRescheduleReceipt(data);
    if (
      result.jobId !== id ||
      (b.action === "confirm" && result.id !== b.quoteId) ||
      (b.action === "review" &&
        Date.parse(result.newStart) !== Date.parse(b.newStart))
    )
      return failure();
    return NextResponse.json(
      b.action === "review"
        ? { quote: result }
        : { rescheduled: true, receipt: result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return failure();
  }
}
function failure(code?: string) {
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
            ? "The appointment, cleaner assignment or fee changed. Review the current visit before confirming."
            : status === 400
              ? "Choose a different future date and time within the next year."
              : "We could not confirm the new appointment. Retry to check the saved result, or call the office.",
    },
    { status },
  );
}
