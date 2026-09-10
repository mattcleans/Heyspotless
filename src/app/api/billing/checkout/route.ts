import { NextResponse, type NextRequest } from "next/server";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { chargeableCents } from "@/lib/billing/amounts";
import { checkoutKeyFor, reconcileInvoiceCollection } from "@/lib/billing/collection";
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
 *
 * COLLECTING ONCE. This route used to create a session every time it was
 * called, with no record that it had. Two tabs got two chargeable pages; a
 * second click got a third; and if the nightly sweep ran while a customer had
 * one open, the card was charged as well. Nothing tied them together, because
 * nothing was written down until the webhook landed.
 *
 * So the order here is: reconcile what is already outstanding, THEN decide
 * whether a new attempt is even warranted, and only then ask Stripe. The
 * reconcile step is what turns "we do not know" into an answer instead of
 * into a second charge.
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

  const store = new BillingStore(createAdminClient());

  // Ask Stripe about anything already in flight BEFORE looking at the
  // balance, because the balance is exactly what a lost payment makes wrong.
  const reconciled = await reconcileInvoiceCollection(store, invoice.id);

  if (reconciled.state === "settled") {
    // Stripe had already taken this money; we just wrote it down. Charging
    // again is the failure this whole path exists to prevent.
    return NextResponse.json(
      {
        status: "already_paid",
        recovered: reconciled.recoveredPayment,
        message: "This invoice has already been paid. Nothing further is owed.",
      },
      { status: 409 },
    );
  }

  if (reconciled.state === "in_flight") {
    // Something is genuinely live. If it is a Checkout page, send them back
    // to THAT page — two tabs then finish the same session rather than
    // opening two. If it is an off-session charge, refuse: we cannot know
    // yet whether it will land.
    if (reconciled.operation?.channel === "checkout" && reconciled.redirectUrl) {
      return NextResponse.json({ url: reconciled.redirectUrl, reused: true });
    }
    return NextResponse.json(
      {
        status: "collection_in_flight",
        channel: reconciled.operation?.channel ?? "unknown",
        message: "A payment for this invoice is already being processed. Please wait for it.",
      },
      { status: 409 },
    );
  }

  // Re-read: reconciliation may have recorded a payment that changed it.
  const current = (await repo.getInvoice(invoiceId)) ?? invoice;

  let amountCents: number;
  try {
    amountCents = chargeableCents(current.amounts, tipCents);
  } catch (error) {
    if (error instanceof BillingError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  // Deterministic in (invoice, balance, tip): two tabs asking to settle the
  // same balance produce the same key and collapse into one attempt.
  const idempotencyKey = checkoutKeyFor(invoice.id, current.balanceCents, tipCents);

  const operation = await store.beginPaymentOperation({
    invoiceId: invoice.id,
    channel: "checkout",
    idempotencyKey,
    amountCents,
    // A Checkout session is good for 24 hours; the operation should not
    // release the invoice before the session it represents is dead.
    ttlSeconds: 24 * 60 * 60,
  });

  if (operation.outcome === "existing" && operation.redirectUrl) {
    // The second identical tab. Same session, same page, one payment.
    return NextResponse.json({ url: operation.redirectUrl, reused: true });
  }

  if (operation.outcome === "blocked") {
    return NextResponse.json(
      {
        status: "collection_in_flight",
        channel: operation.channel,
        message: "A payment for this invoice is already being processed. Please wait for it.",
      },
      { status: 409 },
    );
  }

  const stripeCustomerId = await ensureStripeCustomer(customer);
  if (stripeCustomerId !== customer.stripeCustomerId) {
    await store.setStripeCustomerId(customer.id, stripeCustomerId);
  }

  let session: { id: string; url: string };
  try {
    session = await createCheckoutSession({
      invoiceId: invoice.id,
      stripeCustomerId,
      amountCents,
      tipCents,
      description: `Hey Spotless — invoice ${invoice.id.slice(0, 8)}`,
      origin: request.nextUrl.origin,
      saveCard,
      idempotencyKey,
    });
  } catch (error) {
    // Stripe refused outright, so no session exists and nothing can be paid
    // against it. Release the invoice rather than leaving it blocked.
    await store.resolvePaymentOperation(idempotencyKey, "failed", messageOf(error));
    throw error;
  }

  // Record what the attempt became, immediately. The window between asking
  // Stripe for a session and knowing its id is the one place a payment could
  // still go unaccounted for, and it is now as short as an await.
  await store.attachPaymentOperation({
    idempotencyKey,
    stripeObjectKind: "checkout_session",
    stripeObjectId: session.id,
    redirectUrl: session.url,
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "checkout failed";
}
