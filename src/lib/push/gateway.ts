import "server-only";

import { audienceFor, isPushEnabled, vapidAuthorization, vapidKeys } from "./vapid";

/**
 * The push boundary.
 *
 * A fetch rather than a library, like the Twilio gateway next door and for the
 * same reason: this is one POST with two headers, and the alternative is a
 * dependency that exists to do the payload encryption this deliberately does
 * not do — see `vapid.ts`.
 *
 * Never throws. A push that fails is an ordinary outcome, and the one thing
 * that must not happen is a failed notification taking down the sweep that
 * would have texted her instead.
 */

export type PushResult =
  | { ok: true }
  /** The subscription is gone for good. Delete the row. */
  | { ok: false; gone: true; reason: string }
  | { ok: false; gone: false; reason: string };

/**
 * Wake one device.
 *
 * NO BODY, ON PURPOSE. The service worker fetches the offer from our own API
 * when it wakes, so what it shows is the offer as it is NOW rather than as it
 * was when the push was queued — which matters when a rung lives fifteen
 * minutes and somebody else may already have taken the job. It also means the
 * address and the payout never transit Apple's or Google's infrastructure.
 */
export async function sendPush(endpoint: string, urgency: "high" | "normal" = "high"): Promise<PushResult> {
  if (!isPushEnabled()) return { ok: false, gone: false, reason: "push is disabled" };

  const keys = vapidKeys();
  if (!keys) return { ok: false, gone: false, reason: "push is not configured" };

  let authorization: string;
  try {
    authorization = vapidAuthorization(endpoint, keys);
  } catch (error) {
    // A malformed key. Every push will fail identically, so say so clearly
    // rather than letting it look like a subscription problem.
    return { ok: false, gone: false, reason: messageOf(error) };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization,
        // No body, so no Content-Encoding. A push service rejects a
        // Content-Encoding header with an empty body.
        "content-length": "0",
        // How long the service should hold it for a device that is offline.
        // Fifteen minutes: past that the offer this announces has expired, and
        // a notification about a job somebody else took is worse than silence.
        ttl: "900",
        urgency,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) return { ok: true };

    // 404 and 410 are the push service saying this subscription will never
    // work again — the app was uninstalled, or the browser rotated it. That is
    // a row to delete, not a failure to retry.
    if (response.status === 404 || response.status === 410) {
      return { ok: false, gone: true, reason: `subscription gone (${response.status})` };
    }

    const body = await response.text().catch(() => "");
    return {
      ok: false,
      gone: false,
      reason: `${response.status}: ${body.slice(0, 200)}`.trim(),
    };
  } catch (error) {
    return { ok: false, gone: false, reason: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "push failed";
}

/** Grouped by push service, for the log. Four services cover every device. */
export function serviceOf(endpoint: string): string {
  try {
    return audienceFor(endpoint).replace(/^https:\/\//, "");
  } catch {
    return "unknown";
  }
}
