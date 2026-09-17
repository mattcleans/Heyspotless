import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Move an application one legal step.
 *
 * The state machine lives in SQL (`advance_application`), not here, because the
 * order of these states is the hiring process and it has to hold against a
 * direct update as well as against this route. All this does is prove the
 * caller is an admin and pass the step along.
 *
 * `activated` is deliberately not reachable from here. Only `activate_cleaner`
 * writes it, because activation is the moment a person becomes somebody
 * dispatch can send to a stranger's house, and it has conditions.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STEPS = new Set(["screened", "background_pending", "background_cleared", "rejected"]);

export async function POST(request: NextRequest) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "admins only" }, { status: 403 });

  const body = await readJson(request);
  const id = typeof body["id"] === "string" ? body["id"] : null;
  const status = typeof body["status"] === "string" ? body["status"] : null;
  const reason = typeof body["reason"] === "string" ? body["reason"].slice(0, 500) : null;
  const score = typeof body["score"] === "number" ? body["score"] : null;
  const notes = typeof body["notes"] === "string" ? body["notes"].slice(0, 4000) : null;

  if (!id || !status || !STEPS.has(status)) {
    return NextResponse.json({ error: "id and a valid step are required" }, { status: 400 });
  }

  const { data, error } = await createAdminClient().rpc("advance_application", {
    p_id: id,
    p_status: status,
    p_reason: reason,
    p_by: profile.id,
    p_score: score,
    p_notes: notes,
  });

  if (error) {
    console.error("advance_application failed", error);
    return NextResponse.json({ error: "could not save that" }, { status: 500 });
  }

  // False means the step is not legal from where the application currently is —
  // usually because somebody else moved it in another tab.
  if (data !== true) {
    return NextResponse.json(
      { error: "that step is not available from where this application is now" },
      { status: 409 },
    );
  }

  return NextResponse.json({ status });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
