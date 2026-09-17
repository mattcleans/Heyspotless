import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MessagingStore } from "@/lib/messaging/store";
import { EMPTY_TWIML, formParams, interpret, verifyTwilioSignature } from "@/lib/messaging/inbound";
import { hasTwilioConfig, twilioAuthToken } from "@/lib/messaging/env";

/**
 * Somebody texted back.
 *
 * Until this existed the platform could only talk. A cleaner replying STOP was
 * opted out at the carrier and nowhere else — so dispatch went on writing her
 * offers she could not see, and went on counting each expiry against the
 * acceptance rate that decides what work she is shown next. A customer replying
 * "can we move Tuesday" was received by Twilio and discarded, which is worse
 * than having no number at all: they have every reason to believe somebody read
 * it.
 *
 * THE ORDER HERE IS THE POINT. Record first, interpret second, act third.
 * An inbound message is evidence — of a cancellation, of a complaint, of
 * consent withdrawn — and evidence that is only kept when we understood it is
 * evidence that goes missing exactly when it matters. So every message is
 * written down before anything looks at what it says, including the ones from
 * numbers nobody recognises.
 *
 * Runs with no session, like the Stripe webhook, and for the same reason: the
 * sender is a phone company. The signature is the authentication.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // Nothing to verify against means nothing can be trusted. Refusing is the
  // only safe answer: processing an unverifiable webhook that writes into the
  // customer record is the whole attack this endpoint has to survive.
  if (!hasTwilioConfig()) {
    return NextResponse.json({ error: "messaging is not configured" }, { status: 503 });
  }

  const raw = await request.text();
  const params = formParams(new URLSearchParams(raw));

  /**
   * The URL TWILIO used, not the one the framework reconstructed.
   *
   * Behind Vercel's proxy `request.url` can differ in scheme or host from the
   * public address, and either difference produces a signature that is
   * perfectly valid and does not match. NEXT_PUBLIC_APP_URL is the configured
   * public origin, so it is the one to sign against; the request's own origin
   * is the fallback for local work, where the two are the same thing.
   */
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
  const url = `${origin.replace(/\/$/, "")}${request.nextUrl.pathname}`;

  if (!verifyTwilioSignature(url, params, twilioAuthToken() ?? "", request.headers.get("x-twilio-signature"))) {
    // Deliberately terse. An attacker probing this endpoint learns that the
    // signature was wrong and nothing else — not which part, not what we
    // expected, not whether the number is one we know.
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  const providerId = params["MessageSid"] ?? params["SmsSid"] ?? null;
  const from = params["From"] ?? null;
  const body = params["Body"] ?? "";

  if (!providerId || !from) {
    // Signed by Twilio but not a message. Nothing to record, and nothing worth
    // failing over — a non-2xx here only earns a retry of the same thing.
    return twiml();
  }

  const messaging = new MessagingStore(createAdminClient());

  // Recorded before it is understood.
  const messageId = await messaging.recordInbound({
    providerId,
    from,
    to: params["To"] ?? "",
    body,
  });

  // Null means we already have this MessageSid. Twilio retries anything it did
  // not get a 2xx from — rightly, since the alternative is losing a customer's
  // reply to a deploy — and the cost is the same message arriving twice.
  if (!messageId) return twiml();

  const intent = interpret(body);

  switch (intent.kind) {
    case "opt_out": {
      const touched = await messaging.setOptOutByPhone(from, true, `replied ${intent.word}`);
      // Worth logging rather than silently succeeding: STOP from a number in
      // nobody's record means the number on file is wrong somewhere, and the
      // person it belongs to is still being texted under the old one.
      if (touched === 0) console.warn(`STOP from ${redact(from)} matched no record`);
      break;
    }

    case "opt_in":
      await messaging.setOptOutByPhone(from, false, null);
      break;

    case "help":
    case "message":
      // Both are a person's job. HELP is answered by the carrier's own
      // auto-reply, and a customer's actual message is answered by somebody in
      // the inbox — not by a robot at 11pm, which is the reflex to resist here.
      break;
  }

  return twiml();
}

/**
 * Twilio reads the response body as instructions, so it gets a TwiML document
 * rather than JSON. Empty, because nothing here should answer automatically.
 */
function twiml() {
  return new NextResponse(EMPTY_TWIML, {
    status: 200,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

/** Last four only. A log line is not a place to put somebody's phone number. */
function redact(phone: string): string {
  return `…${phone.slice(-4)}`;
}
