import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoMode } from "@/lib/supabase/env";
import { connectionRefusal, isUuid } from "@/lib/customers/sign-in-connection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Connect a customer's confirmed sign-in to this customer record.
 *
 * Management only, checked here because the database call uses the service
 * role. The database rechecks the saved role of the actor, and makes every
 * other check itself; this route never decides whether a connection is
 * allowed, only who is asking and whether they confirmed the person.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ message: "Sign in to Management." }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ message: "Management access is required." }, { status: 403 });
  if (isDemoMode()) return NextResponse.json({ message: "Sign-ins can't be connected in demo mode." }, { status: 503 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ message: "Refresh the page before connecting a sign-in." }, { status: 403 });
  }

  const { id: customerId } = await params;
  if (!isUuid(customerId)) return NextResponse.json({ message: "Choose a valid customer." }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Choose a sign-in to connect." }, { status: 400 });
  }
  const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!isUuid(fields["profileId"])) return NextResponse.json({ message: "Choose a sign-in to connect." }, { status: 400 });
  if (fields["confirmedIdentity"] !== true) {
    return NextResponse.json({ message: "Confirm who the customer is before connecting their sign-in." }, { status: 400 });
  }

  try {
    const { data, error } = await createAdminClient().rpc("connect_customer_sign_in", {
      p_customer: customerId,
      p_profile: fields["profileId"],
      p_actor: profile.id,
    });
    if (error) throw error;
    const result = (data ?? {}) as Record<string, unknown>;
    if (result["connected"] === true) {
      return NextResponse.json({
        connected: true,
        alreadyConnected: result["alreadyConnected"] === true,
        message:
          result["alreadyConnected"] === true
            ? "This sign-in was already connected to this customer."
            : "Sign-in connected. The customer now sees their account the next time they sign in.",
      });
    }
    return NextResponse.json({ connected: false, message: connectionRefusal(result["reason"]) }, { status: 409 });
  } catch {
    return NextResponse.json({ message: "The connection could not be confirmed. Refresh the page before trying again." }, { status: 503 });
  }
}
