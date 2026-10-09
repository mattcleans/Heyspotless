import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { isChoiceId } from "../cleaner-choice/input";
import {
  parseScheduleAction,
  toScheduleQuote,
  toScheduleReceipt,
} from "./types";
import { clientSchedule } from "./store";
export async function changeRecurringSchedule(
  request: NextRequest,
  id: string,
  office: boolean,
) {
  const repo = await getRepository();
  if (repo.isDemo)
    return NextResponse.json(
      { error: "Preview only. Sign in to change your recurring schedule." },
      { status: 409 },
    );
  const profile = await repo.getCurrentProfile();
  if (!profile)
    return NextResponse.json(
      { error: "Sign in again to save your schedule." },
      { status: 401 },
    );
  if (profile.role !== (office ? "admin" : "customer"))
    return NextResponse.json(
      { error: "Use the correct account to manage this schedule." },
      { status: 403 },
    );
  if (!isChoiceId(id))
    return NextResponse.json(
      { error: "Open a schedule from your account." },
      { status: 400 },
    );
  const db = await createClient(),
    customer = office ? null : await repo.getCustomerByProfile(profile.id);
  const schedule = await clientSchedule(db, id);
  if (
    !schedule ||
    (!office && (!customer || schedule.customerId !== customer.id))
  )
    return NextResponse.json(
      { error: "This schedule is unavailable in your account." },
      { status: 404 },
    );
  let action;
  try {
    action = parseScheduleAction(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Check your schedule." },
      { status: 400 },
    );
  }
  const { data, error } =
    action.action === "review"
      ? await db.rpc("quote_my_recurring_schedule", {
          p_plan: id,
          p_first: action.draft.firstDate,
          p_freq: action.draft.frequency,
          p_time: action.draft.startTime,
          p_pause: action.draft.pausedUntil || null,
          p_end: action.draft.endsOn || null,
        })
      : await db.rpc("confirm_my_recurring_schedule", {
          p_plan: id,
          p_quote: action.quoteId,
        });
  if (error) return failure(error.code);
  try {
    const result =
      action.action === "review"
        ? toScheduleQuote(data)
        : toScheduleReceipt(data);
    if (
      result.review.plan_id !== id ||
      (action.action === "confirm" && result.id !== action.quoteId) ||
      (action.action === "review" &&
        (result.review.first_date !== action.draft.firstDate ||
          result.review.freq !== action.draft.frequency ||
          result.review.start_time !== action.draft.startTime ||
          result.review.paused_until !== (action.draft.pausedUntil || null) ||
          result.review.ends_on !== (action.draft.endsOn || null)))
    )
      return failure();
    return NextResponse.json(
      action.action === "review"
        ? { quote: result }
        : { saved: true, receipt: result },
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
          ? "This schedule is no longer available to your account."
          : status === 409
            ? "Your schedule, cleaner assignment, or billing changed. Review the current dates and price again."
            : status === 400
              ? "Choose a future date within the next year and a frequency available for your service."
              : "We could not verify the saved schedule. Retry the confirmation to check its result, or call the office.",
    },
    { status },
  );
}
