import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  clientVisitAccess,
  choiceFailure,
} from "@/lib/customer/cleaner-choice/access";
import { parseBackupDecision } from "@/lib/customer/cleaner-choice/input";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params,
    access = await clientVisitAccess(id);
  if (access.error) return access.error;
  let b;
  try {
    b = parseBackupDecision(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Review your backup choice." },
      { status: 400 },
    );
  }
  const db = await createClient();
  const { data, error } = await db.rpc("respond_my_visit_backup", {
    p_job_id: id,
    p_assignment_id: b.assignmentId,
    p_preferred_cleaner_id: b.preferredCleanerId,
    p_backup_cleaner_id: b.backupCleanerId,
    p_id: b.id,
    p_accept: b.accept,
    p_note: b.note,
    p_expected_latest: b.expectedLatest,
  });
  if (error) return choiceFailure(error);
  if (!data || data.id !== b.id || data.accepted !== b.accept)
    return choiceFailure(null);
  return NextResponse.json({
    saved: true,
    id: data.id,
    accepted: data.accepted,
  });
}
