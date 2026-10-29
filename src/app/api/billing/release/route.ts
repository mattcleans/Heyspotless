import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { paymentReleaseMessage } from "@/lib/billing/review";
import { isDemoMode } from "@/lib/supabase/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Release a payment claim with no confirmed provider outcome, once Management
 * has checked Stripe. Never calls Stripe, records a payment or changes a balance.
 */
export async function POST(request: NextRequest) {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ message: "Sign in to Management." }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ message: "Management access is required." }, { status: 403 });
  if (isDemoMode()) return NextResponse.json({ message: "Payment requests are unavailable in demo mode." }, { status: 503 });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ message: "Refresh the list before releasing a request." }, { status: 403 });
  }
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ message: "Choose a request to release." }, { status: 400 }); }
  const fields = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (typeof fields.operationId !== "string" || !UUID.test(fields.operationId)) {
    return NextResponse.json({ message: "Choose a valid request to release." }, { status: 400 });
  }
  if (fields.confirmedNoCharge !== true) {
    return NextResponse.json({ message: "Confirm in Stripe that nothing was charged before releasing this request." }, { status: 400 });
  }
  try {
    const result = await new BillingStore(createAdminClient()).releaseUnconfirmedPaymentOperation(fields.operationId, profile.id);
    return NextResponse.json({ released: result.released, message: paymentReleaseMessage(result) }, { status: result.released ? 200 : 409 });
  } catch {
    return NextResponse.json({ message: "The release could not be confirmed. Refresh the list before trying again." }, { status: 503 });
  }
}
