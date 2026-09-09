/**
 * Environment access for Stripe, in the same shape as supabase/env.ts: read
 * through functions so there is one place to fail loudly, and so the secret key
 * is never referenced anywhere a bundler could follow it into client code.
 *
 * Billing is OFF until it is deliberately turned on. At the time of writing the
 * Stripe account is still in underwriting (docs/setup.md phase 00), so the
 * honest default is a system that renders the billing UI as unavailable rather
 * than one that throws at the first click. This mirrors the flag Twilio gets in
 * phase 06 for the same reason: the integration lands before the account does.
 */

export function stripeSecretKey(): string | null {
  return process.env.STRIPE_SECRET_KEY || null;
}

export function stripePublishableKey(): string | null {
  return process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null;
}

export function stripeWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET || null;
}

/** True when there is a real Stripe account to talk to. */
export function hasStripeConfig(): boolean {
  return Boolean(stripeSecretKey());
}

/**
 * The switch every billing entry point checks first.
 *
 * BILLING_ENABLED=1 forces it on, =0 forces it off; unset means "on once Stripe
 * is configured". Demo mode always wins, so a demo can never reach a live card.
 */
export function isBillingEnabled(): boolean {
  if (process.env.DEMO_MODE === "1") return false;
  if (process.env.BILLING_ENABLED === "0") return false;
  if (process.env.BILLING_ENABLED === "1") return true;
  return hasStripeConfig();
}

export function requireStripeConfig(): { secretKey: string } {
  const secretKey = stripeSecretKey();
  if (!secretKey) {
    throw new Error(
      "Stripe is not configured. Set STRIPE_SECRET_KEY, or leave billing " +
        "disabled (BILLING_ENABLED=0). See docs/setup.md.",
    );
  }
  return { secretKey };
}

/**
 * The webhook secret is separate on purpose: an endpoint that cannot verify a
 * signature must refuse to run at all rather than trust the request body.
 */
export function requireWebhookSecret(): string {
  const secret = stripeWebhookSecret();
  if (!secret) {
    throw new Error(
      "STRIPE_WEBHOOK_SECRET is not set. The webhook cannot verify signatures " +
        "without it and will not process events. See docs/setup.md.",
    );
  }
  return secret;
}

/**
 * Guard for the cron-triggered endpoints. Shared with the automation engine in
 * phase 06, which runs on the same schedule mechanism.
 *
 * Compared with a constant-time-ish scan rather than `===` so a wrong secret
 * cannot be recovered a character at a time from response timing.
 */
export function cronSecretMatches(presented: string | null): boolean {
  const expected = process.env.CRON_SECRET || null;
  if (!expected || !presented) return false;
  if (presented.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}
