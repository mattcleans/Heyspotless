import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoMode } from "@/lib/supabase/env";
import { buildQuote } from "@/lib/pricing/quote";
import { FREQUENCIES, SERVICE_TYPES, type Frequency, type ServiceType } from "@/lib/pricing/price-book";
import { MessagingStore, LEAD_ACK } from "@/lib/messaging/store";
import { leadAckMessage } from "@/lib/messaging/templates";
import { sendSms } from "@/lib/messaging/gateway";
import { isMessagingEnabled } from "@/lib/messaging/env";
import { SMS_CONSENT_TEXT } from "@/lib/growth/consent";

/**
 * Somebody asked for a price.
 *
 * THE PRICE IS RECOMPUTED HERE. The widget sends what it showed, and this
 * ignores it except to notice a disagreement: a total in a request body is a
 * discount anybody can grant themselves with a browser console. The inputs are
 * trusted (they are what the customer typed about their own house), the
 * arithmetic is not.
 *
 * THE ACKNOWLEDGEMENT IS SENT INLINE, not queued. Every other message in this
 * system goes through the automation sweep, and this one deliberately does not:
 * the lever this whole phase exists to move is time-to-first-response, and an
 * acknowledgement that waits up to an hour for the next sweep is not an
 * acknowledgement. It is also the one moment we know the person is holding
 * their phone.
 *
 * It does NOT set `first_response_at`. An automated text is not a person
 * answering, and letting it count would make the KPI measure the robot.
 *
 * Public, like the ratings endpoint. What a forged request buys is a fake lead
 * in the inbox, which is spam rather than a breach — and the same thing a
 * contact form has always bought.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (isDemoMode()) {
    return NextResponse.json({ error: "booking needs a live database" }, { status: 503 });
  }

  const body = await readJson(request);

  const firstName = str(body["firstName"], 80);
  const phone = str(body["phone"], 40);
  const address = str(body["address"], 300);

  if (!firstName || !phone || !address) {
    return NextResponse.json(
      { error: "a name, a phone number and an address are needed" },
      { status: 400 },
    );
  }

  const service = SERVICE_TYPES.includes(body["service"] as ServiceType)
    ? (body["service"] as ServiceType)
    : "standard";
  const frequency = FREQUENCIES.includes(body["frequency"] as Frequency)
    ? (body["frequency"] as Frequency)
    : "one_time";

  const raw = (body["rooms"] ?? {}) as Record<string, unknown>;
  const rooms = {
    bedrooms: count(raw["bedrooms"], 8),
    bathrooms: count(raw["bathrooms"], 8),
    halfBaths: count(raw["halfBaths"], 4),
    kitchens: 1,
    livingRooms: 1,
    utilityRooms: 1,
  };

  let quoted: { totalCents: number; estimatedMinutes: number } | null = null;
  try {
    const quote = buildQuote(service, frequency, rooms);
    quoted = { totalCents: quote.totalCents, estimatedMinutes: quote.estimatedMinutes };
  } catch {
    // An unsellable combination — Deep at weekly, say. The enquiry is still
    // worth having; it just arrives without a number on it, and the office
    // prices it by hand. Losing the lead over a form validation would be
    // exactly backwards.
    quoted = null;
  }

  // Worth knowing, never worth blocking on: if these disagree the widget and
  // the price book have drifted, which is the failure mode the shared pure
  // function exists to prevent.
  const shown = typeof body["shownTotalCents"] === "number" ? body["shownTotalCents"] : null;
  if (quoted && shown !== null && shown !== quoted.totalCents) {
    console.warn(`booking widget showed ${shown}, price book says ${quoted.totalCents}`);
  }

  const consented = body["smsConsent"] === true;
  const db = createAdminClient();

  const { data, error } = await db.rpc("record_lead", {
    p_first_name: firstName,
    p_last_name: str(body["lastName"], 80),
    p_email: str(body["email"], 200),
    p_phone: phone,
    p_raw_address: address,
    p_zip: str(body["zip"], 20),
    p_service: service,
    p_service_type: service,
    p_freq: frequency,
    p_bedrooms: rooms.bedrooms,
    p_bathrooms: rooms.bathrooms,
    p_half_baths: rooms.halfBaths,
    p_quoted_price_cents: quoted?.totalCents ?? null,
    p_estimated_minutes: quoted?.estimatedMinutes ?? null,
    p_message: str(body["note"], 2000),
    p_sms_consent_text: consented ? SMS_CONSENT_TEXT : null,
    p_attribution: attributionOf(request),
    p_source: "website",
  });

  if (error || typeof data !== "string") {
    console.error("record_lead failed", error);
    return NextResponse.json({ error: "could not save that" }, { status: 500 });
  }

  const leadId = data;

  // Acknowledge now. Failing to text does not fail the booking: the lead is
  // saved, and an enquiry in the inbox with no acknowledgement is a worse
  // outcome than either, but it is the one the office can still rescue.
  if (consented && isMessagingEnabled()) {
    try {
      const messaging = new MessagingStore(db);
      const text = leadAckMessage({
        firstName,
        quotedCents: quoted?.totalCents ?? null,
      });

      const messageId = await messaging.claimByKey({
        dedupeKey: `lead:${leadId}:ack`,
        kind: LEAD_ACK,
        body: text,
        to: phone,
        leadId,
      });

      if (messageId) {
        const sent = await sendSms(phone, text);
        await messaging.settle(
          messageId,
          sent.ok ? sent.providerId : null,
          sent.ok ? null : sent.reason,
        );
      }
    } catch (e) {
      console.error("lead acknowledgement failed", e);
    }
  }

  return NextResponse.json({ received: true });
}

/**
 * Where the enquiry came from, for the marketing arithmetic this phase exists
 * to fix. Query parameters and the referrer only — no cookies, no fingerprint,
 * nothing that follows anybody anywhere.
 */
function attributionOf(request: NextRequest): Record<string, string> | null {
  const attribution: Record<string, string> = {};

  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    if (key.startsWith("utm_") || key === "ref" || key === "gclid") {
      attribution[key] = value.slice(0, 200);
    }
  }

  const referrer = request.headers.get("referer");
  if (referrer) attribution["referrer"] = referrer.slice(0, 300);

  return Object.keys(attribution).length > 0 ? attribution : null;
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function count(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.round(value)));
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
