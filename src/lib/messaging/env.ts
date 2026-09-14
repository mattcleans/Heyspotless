/**
 * Environment access for Twilio, in the same shape as stripe/env.ts: read
 * through functions so there is one place to fail loudly, and so the auth token
 * is never referenced anywhere a bundler could follow it into client code.
 *
 * Messaging is OFF until it is deliberately turned on. A2P 10DLC approval
 * landed 14 September 2026, so the account exists — but the same posture still
 * applies, because a demo or a local run must never text a real cleaner.
 */

export function twilioAccountSid(): string | null {
  return process.env.TWILIO_ACCOUNT_SID || null;
}

export function twilioAuthToken(): string | null {
  return process.env.TWILIO_AUTH_TOKEN || null;
}

/**
 * The messaging service, not a bare phone number. A2P campaigns are registered
 * against a messaging service, so sending from a number outside it is the
 * traffic carriers filter.
 */
export function twilioMessagingServiceSid(): string | null {
  return process.env.TWILIO_MESSAGING_SERVICE_SID || null;
}

export function hasTwilioConfig(): boolean {
  return Boolean(twilioAccountSid() && twilioAuthToken() && twilioMessagingServiceSid());
}

/**
 * The switch every send path checks first.
 *
 * MESSAGING_ENABLED=1 forces it on, =0 forces it off; unset means "on once
 * Twilio is configured". Demo mode always wins, so a demo can never text
 * anybody — the same rule billing has, for the same reason.
 */
export function isMessagingEnabled(): boolean {
  if (process.env.DEMO_MODE === "1") return false;
  if (process.env.MESSAGING_ENABLED === "0") return false;
  if (process.env.MESSAGING_ENABLED === "1") return true;
  return hasTwilioConfig();
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
}

export function requireTwilioConfig(): TwilioConfig {
  const accountSid = twilioAccountSid();
  const authToken = twilioAuthToken();
  const messagingServiceSid = twilioMessagingServiceSid();

  if (!accountSid || !authToken || !messagingServiceSid) {
    throw new Error(
      "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and " +
        "TWILIO_MESSAGING_SERVICE_SID, or leave messaging disabled " +
        "(MESSAGING_ENABLED=0). See docs/setup.md.",
    );
  }
  return { accountSid, authToken, messagingServiceSid };
}
