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

  /**
   * NAME THE ONES THAT ARE ACTUALLY MISSING.
   *
   * This used to list all three whatever the problem was, and the message is
   * recorded against the message row rather than raised — so a live run showed
   * "set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_MESSAGING_SERVICE_SID"
   * against three variables that were all visibly present in the dashboard,
   * and cost a session to not diagnose. Vercel encrypts these once saved, so
   * the value cannot be read back and this string is the only evidence there
   * is. It should say which one.
   */
  const missing = [
    accountSid ? null : "TWILIO_ACCOUNT_SID",
    authToken ? null : "TWILIO_AUTH_TOKEN",
    messagingServiceSid ? null : "TWILIO_MESSAGING_SERVICE_SID",
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new Error(
      `Twilio is not configured: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} unset or empty in this ` +
        `deployment. Environment changes need a redeploy to take effect. ` +
        `Or leave messaging disabled (MESSAGING_ENABLED=0). See docs/setup.md.`,
    );
  }
  return {
    accountSid: accountSid as string,
    authToken: authToken as string,
    messagingServiceSid: messagingServiceSid as string,
  };
}
