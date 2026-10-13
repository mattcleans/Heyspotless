import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  clientVisitAccess,
  choiceFailure,
} from "@/lib/customer/cleaner-choice/access";
import { parseCleanerRequest } from "@/lib/customer/cleaner-choice/input";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params,
    access = await clientVisitAccess(id);
  if (access.error) return access.error;
  let b;
  try {
    b = parseCleanerRequest(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Check your choice." },
      { status: 400 },
    );
  }
  const db = await createClient();
  const { data, error } = await db.rpc("request_my_visit_cleaner", {
    p_job_id: id,
    p_cleaner_id: b.cleanerId,
    p_id: b.id,
    p_note: b.note,
    p_expected_latest: b.expectedLatest,
  });
  if (error) return choiceFailure(error);
  if (
    !data ||
    data.id !== b.id ||
    !["pending", "applied", "declined", "withdrawn"].includes(data.status)
  )
    return choiceFailure(null);
  return NextResponse.json({ saved: true, id: data.id, status: data.status });
}
