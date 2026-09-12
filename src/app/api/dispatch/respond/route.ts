import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { DispatchStore, type OfferResponse } from "@/lib/dispatch/store";

/**
 * A cleaner answers an offer.
 *
 * This is the step the whole service loop was missing: jobs were generated,
 * priced and matched, and then nothing could be accepted, so nothing after
 * matching could happen at all.
 *
 * Three things are settled here and nowhere else:
 *
 *   1. WHO IS ASKING is taken from the session, never the body. An offer id is
 *      not a secret worth relying on, and `cleanerId` in a request body is a
 *      request to answer somebody else's offer.
 *   2. WHAT IT PAYS is not in the request at all. `respond_to_offer` reads the
 *      payout off the offer row. 0007 removed the cleaner's UPDATE permission
 *      on offers because it doubled as permission to rewrite her own payout;
 *      an endpoint that accepted an amount would hand it straight back.
 *   3. WHO WON is decided by the database under a row lock on the job, so two
 *      cleaners accepting in the same second produce one assignment and one
 *      honest "somebody got there first".
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What each outcome means to the person holding the phone. */
const MESSAGES: Record<OfferResponse, string> = {
  accepted: "Booked. It's on your schedule.",
  declined: "Thanks — we'll find someone else for this one.",
  taken: "Someone else took this one just now. It won't count against you.",
  expired: "This offer has expired.",
  superseded: "You've already answered this one.",
  not_found: "That offer isn't available.",
};

/** A response that did not land the job is not a client error. */
const STATUS: Record<OfferResponse, number> = {
  accepted: 200,
  declined: 200,
  taken: 409,
  expired: 410,
  superseded: 200,
  not_found: 404,
};

export async function POST(request: NextRequest) {
  const body = await readJson(request);

  const offerId = typeof body["offerId"] === "string" ? body["offerId"] : null;
  const accept = body["accept"];
  if (!offerId || typeof accept !== "boolean") {
    return NextResponse.json(
      { error: "offerId (string) and accept (boolean) are required" },
      { status: 400 },
    );
  }

  const reason = typeof body["reason"] === "string" ? body["reason"].slice(0, 500) : null;

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const cleaner = await repo.getCleanerByProfile(profile.id);
  if (!cleaner) return NextResponse.json({ error: "no cleaner record" }, { status: 403 });

  const store = new DispatchStore(createAdminClient());
  const outcome = await store.respond(offerId, cleaner.id, accept, reason);

  return NextResponse.json(
    { outcome, message: MESSAGES[outcome] },
    { status: STATUS[outcome] },
  );
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
