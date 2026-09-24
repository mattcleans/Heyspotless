import "server-only";

import type { Job } from "../data/types";
import { MessagingStore, OFFER_SENT, type Recipient } from "../messaging/store";
import { offerMessage } from "../messaging/templates";
import { sendSms } from "../messaging/gateway";
import { PushStore } from "../push/store";
import { sendPush } from "../push/gateway";

/**
 * Telling a cleaner an offer exists: a push to her devices and a text.
 *
 * Shared by the dispatch sweep and by a manager offering a job from the
 * dispatch board, so both reach her the same way. Deciding WHETHER she can be
 * told (reachability, quiet hours) is the caller's job, before the offer is
 * written.
 */
export interface AnnounceDeps {
  messaging: MessagingStore;
  pushStore: PushStore;
  /** Registered push endpoints, by cleaner. */
  pushTargets: Map<string, string[]>;
  origin: string;
}

/**
 * Ring every device this cleaner has registered. Returns how many pushes went.
 *
 * Never throws and never blocks the offer: a notification is an improvement on
 * the text, not a replacement for it, and a push service having a bad minute
 * must not cost anybody a job.
 *
 * A subscription the service says is GONE is deleted on the spot. The
 * alternative is a table that fills with dead endpoints, each of them tried and
 * failed on every sweep for ever.
 */
export async function wakeCleaner(deps: AnnounceDeps, cleanerId: string): Promise<number> {
  const endpoints = deps.pushTargets.get(cleanerId);
  if (!endpoints || endpoints.length === 0) return 0;

  let pushed = 0;
  for (const endpoint of endpoints) {
    try {
      const sent = await sendPush(endpoint);

      if (sent.ok) {
        pushed += 1;
        await deps.pushStore.settle(endpoint, true);
        continue;
      }

      if (sent.gone) {
        await deps.pushStore.remove(endpoint);
        continue;
      }

      await deps.pushStore.settle(endpoint, false);
    } catch (error) {
      // Recorded and moved past. She still gets the text.
      console.warn(`push failed for cleaner ${cleanerId}: ${messageOf(error)}`);
    }
  }
  return pushed;
}

export interface OfferText {
  offerId: string;
  job: Job;
  cleanerId: string;
  recipient: Recipient;
  phone: string;
  payoutCents: number;
  expiresAt: Date;
  isExclusive: boolean;
}

/**
 * Text her about the offer.
 *
 * Returns true when the text went, false when the provider refused it, and
 * null when an earlier run already told her about this offer.
 */
export async function textOffer(deps: AnnounceDeps, offer: OfferText): Promise<boolean | null> {
  const body = offerMessage({
    cleanerFirstName: offer.recipient.firstName,
    customerName: offer.job.customerName,
    street: offer.job.street,
    city: offer.job.city,
    payoutCents: offer.payoutCents,
    scheduledStart: offer.job.scheduledStart,
    expiresAt: offer.expiresAt,
    isExclusive: offer.isExclusive,
    offerUrl: `${deps.origin}/cleaner`,
  });

  // Claimed before the provider is called: a crash between sending and
  // recording would otherwise leave no row, and the next sweep would send
  // again. Null means an earlier sweep already told her.
  const messageId = await deps.messaging.claim({
    offerId: offer.offerId,
    kind: OFFER_SENT,
    cleanerId: offer.cleanerId,
    jobId: offer.job.id,
    body,
    to: offer.phone,
  });
  if (!messageId) return null;

  const sent = await sendSms(offer.phone, body);
  if (sent.ok) {
    await deps.messaging.settle(messageId, sent.providerId);
    return true;
  }
  // Recorded, never swallowed. A cleaner we could not reach must not end up
  // indistinguishable from one who ignored us.
  await deps.messaging.settle(messageId, null, sent.reason);
  return false;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "notification failed";
}
