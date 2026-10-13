import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { parseQuoteAction, toClientQuote } from "@/lib/quotes/types";
function failure(code?: string) {
  if (code === "42501")
    return NextResponse.json(
      { error: "Use the client or office account for this quote." },
      { status: 403 },
    );
  if (code === "PT409")
    return NextResponse.json(
      {
        error:
          "The quote or decision changed. Refresh and review before continuing.",
      },
      { status: 409 },
    );
  if (code === "22023" || code === "23514")
    return NextResponse.json(
      {
        error:
          "Check the saved home, Dallas dates, client account and quote details.",
      },
      { status: 400 },
    );
  return NextResponse.json(
    {
      error:
        "We could not confirm the save. Retry the same action to check its result.",
      retryable: true,
    },
    { status: 503 },
  );
}
export async function POST(request: NextRequest) {
  const repo = await getRepository(),
    profile = await repo.getCurrentProfile();
  if (!profile)
    return NextResponse.json(
      { error: "Sign in again to continue." },
      { status: 401 },
    );
  if (repo.isDemo)
    return NextResponse.json(
      { error: "Sample quotes cannot be changed." },
      { status: 409 },
    );
  let b;
  try {
    b = parseQuoteAction(await request.json());
  } catch {
    return failure("22023");
  }
  if (profile.role !== (b.action === "decide" ? "customer" : "admin"))
    return failure("42501");
  const db = await createClient();
  const result =
    b.action === "prepare"
      ? await db.rpc("prepare_client_quote", {
          p_id: b.id,
          p_property_id: b.propertyId,
          p_service: b.service,
          p_freq: b.frequency,
          p_start: b.start,
          p_expires: b.expires,
          p_repeats: b.repeats,
          p_extras: b.extras,
          p_note: b.note,
        })
      : b.action === "decide"
        ? await db.rpc("decide_client_quote", {
            p_id: b.id,
            p_request: b.requestId,
            p_version: b.version,
            p_accept: b.accept,
          })
        : b.action === "book"
          ? await db.rpc("book_client_quote", {
              p_id: b.id,
              p_version: b.version,
            })
          : await db.rpc(
              b.action === "publish"
                ? "publish_client_quote"
                : "withdraw_client_quote",
              { p_id: b.id },
            );
  if (result.error) return failure(result.error.code);
  try {
    const q = toClientQuote(result.data);
    if (
      q.id !== b.id ||
      (b.action === "prepare" && q.propertyId !== b.propertyId)
    )
      return failure();
    if (
      (b.action === "book" && q.state !== "booked") ||
      (b.action === "withdraw" && q.state !== "withdrawn") ||
      (b.action === "publish" && q.state === "review") ||
      (b.action === "decide" && q.decisionId === null)
    )
      return failure();
    return NextResponse.json(q);
  } catch {
    return failure();
  }
}
