import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { choiceFailure } from "@/lib/customer/cleaner-choice/access";
import {
  isChoiceId,
  parseChoiceReview,
} from "@/lib/customer/cleaner-choice/input";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const repo = await getRepository(),
    profile = await repo.getCurrentProfile();
  if (!profile)
    return NextResponse.json(
      { error: "Sign in to review client requests." },
      { status: 401 },
    );
  if (profile.role !== "admin")
    return NextResponse.json(
      { error: "Management access required." },
      { status: 403 },
    );
  if (repo.isDemo)
    return NextResponse.json(
      { error: "Preview requests cannot be reviewed." },
      { status: 409 },
    );
  const { id } = await params;
  if (!isChoiceId(id))
    return NextResponse.json({ error: "Request not found." }, { status: 404 });
  let b;
  try {
    b = parseChoiceReview(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Check your review." },
      { status: 400 },
    );
  }
  const db = await createClient();
  const { data, error } = await db.rpc("review_visit_cleaner_request", {
    p_id: id,
    p_apply: b.apply,
    p_note: b.note,
  });
  if (error) return choiceFailure(error);
  if (
    !data ||
    data.id !== id ||
    data.status !== (b.apply ? "applied" : "declined")
  )
    return choiceFailure(null);
  return NextResponse.json({ saved: true, status: data.status });
}
