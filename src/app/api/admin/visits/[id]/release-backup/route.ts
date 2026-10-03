import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import { choiceFailure } from "@/lib/customer/cleaner-choice/access";
import {
  isChoiceId,
  parseBackupRelease,
} from "@/lib/customer/cleaner-choice/input";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const repo = await getRepository(),
    profile = await repo.getCurrentProfile();
  if (!profile)
    return NextResponse.json(
      { error: "Sign in to review assignments." },
      { status: 401 },
    );
  if (profile.role !== "admin")
    return NextResponse.json(
      { error: "Management access required." },
      { status: 403 },
    );
  if (repo.isDemo)
    return NextResponse.json(
      { error: "Preview assignments cannot be changed." },
      { status: 409 },
    );
  const { id } = await params;
  if (!isChoiceId(id))
    return NextResponse.json({ error: "Visit not found." }, { status: 404 });
  let b;
  try {
    b = parseBackupRelease(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Check the assignment." },
      { status: 400 },
    );
  }
  const { data, error } = await (
    await createClient()
  ).rpc("release_declined_visit_backup", {
    p_job_id: id,
    p_assignment_id: b.assignmentId,
    p_preferred_cleaner_id: b.preferredCleanerId,
    p_backup_cleaner_id: b.backupCleanerId,
    p_decision_id: b.decisionId,
  });
  if (error) return choiceFailure(error);
  if (data !== true) return choiceFailure(null);
  return NextResponse.json({ released: true });
}
