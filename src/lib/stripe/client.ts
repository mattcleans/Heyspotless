import "server-only";

import Stripe from "stripe";
import { requireStripeConfig } from "./env";

/**
 * The Stripe client, created once per process.
 *
 * `server-only` above makes importing this from a client component a build
 * error rather than a leaked secret key — the same guard supabase/admin.ts uses
 * for the service-role key, and for the same reason.
 *
 * The API version is left to the SDK, which pins the version it was built and
 * typed against. Naming one here would let the pin and the types drift apart on
 * the next `npm update`, which is how a "harmless" upgrade starts returning
 * fields the mappers do not expect.
 */
let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (cached) return cached;
  const { secretKey } = requireStripeConfig();
  cached = new Stripe(secretKey, {
    // Surfaces this app by name in the Stripe dashboard's request logs, which
    // is what makes an unexpected charge traceable to a code path.
    appInfo: { name: "Spotless Ops", url: "https://app.heyspotless.com" },
    maxNetworkRetries: 2,
  });
  return cached;
}

export type { Stripe };
