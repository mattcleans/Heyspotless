import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { createSetupSession, ensureStripeCustomer } from "@/lib/billing/gateway";
import { isBillingEnabled } from "@/lib/stripe/env";

/**
 * Save a card, and optionally switch autopay on in the same act.
 *
 * These are two different permissions and the UI must ask for them separately:
 * a card on file is not consent to charge it. `autopay: true` here means the
 * customer ticked the box, and it is what writes the consent timestamp that
 * 0006 requires before any auto-charge can run.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "billing is not enabled" }, { status: 503 });
  }

  const body = await readJson(request);
  const autopay = body["autopay"];

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const customer = await repo.getCustomerByProfile(profile.id);
  if (!customer) return NextResponse.json({ error: "no customer record" }, { status: 404 });

  const store = new BillingStore(createAdminClient());

  if (typeof autopay === "boolean") {
    await store.setAutopay(customer.id, autopay);
  }

  const stripeCustomerId = await ensureStripeCustomer(customer);
  if (stripeCustomerId !== customer.stripeCustomerId) {
    await store.setStripeCustomerId(customer.id, stripeCustomerId);
  }

  const session = await createSetupSession({
    stripeCustomerId,
    origin: request.nextUrl.origin,
  });

  // The card itself is mirrored when `payment_method.attached` arrives; there
  // is nothing to write here, and guessing at it from the session would store
  // a card we cannot prove Stripe actually attached.
  return NextResponse.json({ url: session.url });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
