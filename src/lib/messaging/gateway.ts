import "server-only";

import { isMessagingEnabled, requireTwilioConfig } from "./env";

/**
 * The Twilio boundary.
 *
 * Deliberately a fetch against the REST API rather than the SDK. The SDK is a
 * large dependency for one POST, and this runs inside a request handler on
 * Vercel where cold-start size is not free. If the surface grows past sending,
 * that trade changes.
 *
 * `server-only` makes importing this from a client component a build error
 * rather than a leaked auth token — the same guard the Stripe client and the
 * Supabase service-role client use.
 */

export type SendResult =
  | { ok: true; providerId: string }
  | { ok: false; reason: string; retryable: boolean };

const TWILIO_API = "https://api.twilio.com/2010-04-01";

/**
 * Send one message.
 *
 * Never throws. A failed send is an ordinary outcome that has to be RECORDED —
 * a cleaner we could not reach must not end up indistinguishable from one who
 * ignored us, because acceptance rate drives ranking and that difference is her
 * standing in the marketplace.
 */
export async function sendSms(to: string, body: string): Promise<SendResult> {
  if (!isMessagingEnabled()) {
    return { ok: false, reason: "messaging is disabled", retryable: false };
  }

  let config;
  try {
    config = requireTwilioConfig();
  } catch (error) {
    return { ok: false, reason: messageOf(error), retryable: false };
  }

  const params = new URLSearchParams({
    To: to,
    Body: body,
    MessagingServiceSid: config.messagingServiceSid,
  });

  try {
    const response = await fetch(
      `${TWILIO_API}/Accounts/${config.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization:
            "Basic " +
            Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: params,
        // A sweep that hangs on one unreachable cleaner fills nothing else.
        signal: AbortSignal.timeout(10_000),
      },
    );

    const payload: unknown = await response.json().catch(() => ({}));
    const data = (payload ?? {}) as { sid?: unknown; message?: unknown; code?: unknown };

    if (!response.ok) {
      // 4xx is our fault and will fail identically next time — an unreachable
      // number, an unregistered sender. 5xx and 429 are Twilio's and are worth
      // another go. Retrying the first kind for ever is how a queue silts up.
      const retryable = response.status >= 500 || response.status === 429;
      const reason =
        typeof data.message === "string"
          ? `${response.status}: ${data.message}`
          : `twilio returned ${response.status}`;
      return { ok: false, reason: reason.slice(0, 500), retryable };
    }

    if (typeof data.sid !== "string") {
      return { ok: false, reason: "twilio accepted the send but returned no sid", retryable: false };
    }
    return { ok: true, providerId: data.sid };
  } catch (error) {
    // A timeout or a DNS failure. Ours to retry.
    return { ok: false, reason: messageOf(error), retryable: true };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "send failed";
}
