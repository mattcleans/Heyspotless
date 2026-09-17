import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Won, lost, spam — and the chase stops with it.
 *
 * Admin only, and separate from the public `/api/leads` for exactly that
 * reason: one endpoint takes anonymous enquiries and the other decides their
 * outcome, and collapsing them would mean a form submission could mark somebody
 * else's lead as won.
 *
 * `set_lead_status` cancels the unfired nudges in the same statement, so
 * stopping the sequence is not a second thing anybody has to remember.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set(["new", "quoted", "won", "lost", "spam"]);

export async function POST(request: NextRequest) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  if (profile.role !== "admin") {
    return NextResponse.json({ error: "admins only" }, { status: 403 });
  }

  const body = await readJson(request);
  const leadId = typeof body["leadId"] === "string" ? body["leadId"] : null;
  const status = typeof body["status"] === "string" ? body["status"] : null;

  if (!leadId || !status || !STATUSES.has(status)) {
    return NextResponse.json({ error: "leadId and a valid status are required" }, { status: 400 });
  }

  const { error } = await createAdminClient().rpc("set_lead_status", {
    p_lead_id: leadId,
    p_status: status,
  });

  if (error) {
    console.error("set_lead_status failed", error);
    return NextResponse.json({ error: "could not save that" }, { status: 500 });
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
