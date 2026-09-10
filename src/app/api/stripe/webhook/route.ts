import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BillingStore } from "@/lib/billing/store";
import { handleStripeEvent } from "@/lib/billing/webhook";
import type { StripeEventLike } from "@/lib/billing/events";
import { getStripe } from "@/lib/stripe/client";
import { isBillingEnabled, requireWebhookSecret, stripeWebhookSecret } from "@/lib/stripe/env";

/**
 * The Stripe webhook. Everything that settles an invoice arrives here.
 *
 * Node runtime, because signature verification needs the RAW request body and
 * node crypto. Reading it any other way — `request.json()`, a body parser, a
 * middleware that touches it — re-serialises the bytes and every signature
 * fails, which is the classic and very confusing way to break this endpoint.
 *
 * This file does the two things that need a request: verify the signature,
 * and shape the response. Everything after that is `handleStripeEvent`, which
 * is where the claim, lease and retry behaviour is tested.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The lease in 0010 is five minutes, comfortably clear of this. */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!isBillingEnabled() || !stripeWebhookSecret()) {
    // 503 rather than 404: Stripe should retry once billing is switched on,
    // and an operator reading the dashboard should see "not ready", not "gone".
    return NextResponse.json({ error: "billing is not enabled" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing stripe-signature" }, { status: 400 });
  }

  const rawBody = await request.text();

  let event: StripeEventLike;
  try {
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      requireWebhookSecret(),
    ) as unknown as StripeEventLike;
  } catch {
    // Never echo the reason. An unverified body is an untrusted body, and a
    // precise error here is a hint to whoever is guessing at the secret.
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const store = new BillingStore(createAdminClient());
  const result = await handleStripeEvent(store, event, { payload: safeParse(rawBody) });

  return NextResponse.json(result.body, { status: result.status });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
