import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { chargeableCents } from "@/lib/billing/amounts";
import { createCheckoutSession, ensureStripeCustomer } from "@/lib/billing/gateway";
import { BillingError } from "@/lib/billing/types";
import { isBillingEnabled } from "@/lib/stripe/env";

/**
 * Start a Checkout session for one invoice.
 *
 * Authorisation is row-level security, not a check written here: the repository
 * reads as the signed-in user, so `getInvoice` returns null for an invoice that
 * is not theirs and the request 404s. A permission bug in this file cannot open
 * someone else's invoice, because this file never gets to see it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "billing is not enabled" }, { status: 503 });
  }

  const body = await readJson(request);
  const invoiceId = typeof body["invoiceId"] === "string" ? body["invoiceId"] : null;
  const tipCents = Math.max(0, Math.trunc(Number(body["tipCents"] ?? 0)) || 0);
  const saveCard = body["saveCard"] === true;

  if (!invoiceId) {
    return NextResponse.json({ error: "invoiceId is required" }, { status: 400 });
  }

  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const invoice = await repo.getInvoice(invoiceId);
  if (!invoice) return NextResponse.json({ error: "invoice not found" }, { status: 404 });

  const customer = await repo.getCustomer(invoice.customerId);
  if (!customer) return NextResponse.json({ error: "invoice not found" }, { status: 404 });

  let amountCents: number;
  try {
    amountCents = chargeableCents(invoice.amounts, tipCents);
  } catch (error) {
    if (error instanceof BillingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  const store = new BillingStore(createAdminClient());

  const stripeCustomerId = await ensureStripeCustomer(customer);
  if (stripeCustomerId !== customer.stripeCustomerId) {
    await store.setStripeCustomerId(customer.id, stripeCustomerId);
  }

  const session = await createCheckoutSession({
    invoiceId: invoice.id,
    stripeCustomerId,
    amountCents,
    tipCents,
    description: `Hey Spotless — invoice ${invoice.id.slice(0, 8)}`,
    origin: request.nextUrl.origin,
    saveCard,
  });

  await store.setCheckoutSession(invoice.id, session.id);

  // The money is NOT recorded here. It is recorded when the webhook confirms
  // it, because a customer closing the tab on the Stripe page would otherwise
  // leave an invoice marked paid that never was.
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
