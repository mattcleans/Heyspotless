import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Put somebody on the roster.
 *
 * THE MOST CONSEQUENTIAL BUTTON IN THE ADMIN APP. After this the dispatch
 * engine can send this person, alone, to a stranger's home with a gate code.
 * Every condition that matters is enforced in `activate_cleaner` rather than
 * here — the cleared check, the insurance a contractor must carry, and the
 * provisional rating without which she would sit on the roster invisible to
 * dispatch for ever.
 *
 * The date is the one thing this route collects that the application does not
 * already hold: insurance expiry is a fact about a document somebody has just
 * looked at, and the gate compares it against each job's date.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "admins only" }, { status: 403 });

  const body = await readJson(request);
  const id = typeof body["id"] === "string" ? body["id"] : null;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const type = body["type"] === "w2_core" ? "w2_core" : "contractor_1099";
  const insuranceExpiresOn =
    typeof body["insuranceExpiresOn"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body["insuranceExpiresOn"])
      ? body["insuranceExpiresOn"]
      : null;

  const db = createAdminClient();

  // Written before activation rather than passed through it: the expiry belongs
  // to the application (it is a fact about a document that was produced), and
  // `activate_cleaner` reads it from there so a direct SQL activation cannot
  // skip it either.
  if (insuranceExpiresOn) {
    const { error } = await db
      .from("applications")
      .update({ insurance_expires_on: insuranceExpiresOn })
      .eq("id", id);
    if (error) {
      console.error("insurance update failed", error);
      return NextResponse.json({ error: "could not save the insurance date" }, { status: 500 });
    }
  }

  const { data, error } = await db.rpc("activate_cleaner", {
    p_application_id: id,
    p_type: type,
    p_profile_id: null,
    p_hourly_rate_cents: typeof body["hourlyRateCents"] === "number" ? body["hourlyRateCents"] : null,
    p_guaranteed_hours: typeof body["guaranteedHours"] === "number" ? body["guaranteedHours"] : null,
  });

  if (error) {
    // The two refusals worth reading back verbatim: the check is not cleared,
    // and a contractor has no insurance on file. Both are the office's to fix
    // and neither is a bug.
    const message = typeof error.message === "string" ? error.message : "could not activate";
    console.error("activate_cleaner failed", error);
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 409 });
  }

  if (typeof data !== "string") {
    return NextResponse.json({ error: "that application cannot be activated" }, { status: 409 });
  }

  return NextResponse.json({
    cleanerId: data,
    // Said back deliberately: whoever pressed the button should know she starts
    // provisionally rated rather than unrated, and why she is immediately
    // eligible for work.
    note: "Activated with a provisional rating so dispatch can offer her work from today.",
  });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
