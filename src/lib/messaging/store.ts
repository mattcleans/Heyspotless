import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Recording what the platform said, and to whom.
 *
 * Same division as billing and dispatch: the decision of WHETHER to send lives
 * in quiet-hours.ts, WHAT to say lives in templates.ts, and both are pure. This
 * writes it down and calls the provider.
 *
 * Service-role, because the dispatch sweep runs with no signed-in user.
 */

/** Message kinds. Text rather than an enum — see 0019. */
export const OFFER_SENT = "offer.sent";
export const OFFER_WITHDRAWN = "offer.withdrawn";
export const OFFER_ACCEPTED = "offer.accepted";

/** Customer-facing kinds, sent by the automation sweep and the cleaner app. */
export const BOOKING_CONFIRMED = "booking.confirmed";
export const VISIT_REMINDER = "visit.reminder";
export const ON_MY_WAY = "visit.on_my_way";
export const REVIEW_REQUEST = "review.request";
export const INBOX_REPLY = "inbox.reply";

/** Lead-facing kinds (phase 07). */
export const LEAD_ACK = "lead.ack";
export const LEAD_NUDGE = "lead.nudge";

export interface Recipient {
  cleanerId: string;
  profileId: string | null;
  firstName: string;
  phone: string | null;
  optedOut: boolean;
}

export class MessagingStore {
  constructor(private readonly db: SupabaseClient) {}

  /**
   * Claim the right to send one message about one offer.
   *
   * Returns the message id, or null when one of this kind has already been
   * recorded — which the caller reads as "already told her, send nothing".
   * Null is the ordinary answer on every sweep after the first, and it is what
   * stops an hourly sweep texting a cleaner four times about one clean.
   *
   * Recorded BEFORE the provider is called, deliberately. The alternative
   * loses: a crash between sending and recording leaves no row, and the next
   * sweep sends again.
   */
  async claim(input: {
    offerId: string;
    kind: string;
    cleanerId: string;
    jobId: string;
    body: string;
    to: string;
  }): Promise<string | null> {
    const { data, error } = await this.db.rpc("record_outbound_message", {
      p_offer_id: input.offerId,
      p_kind: input.kind,
      p_cleaner_id: input.cleanerId,
      p_job_id: input.jobId,
      p_channel: "sms",
      p_body: input.body,
      p_to_address: input.to,
    });
    if (error) throw new Error(`claim: ${error.message}`);
    return typeof data === "string" ? data : null;
  }

  /**
   * Claim the right to send one message identified by what it is ABOUT.
   *
   * The same contract as `claim` above — the id, or null when this exact
   * message has already been recorded — for everything that is not an offer.
   * Callers build the key from the subject and the action: a reminder about a
   * job is `job:<uuid>:sms.visit_reminder`, for ever.
   *
   * `dedupeKey: null` opts out of deduplication, which is what a person typing
   * a reply in the inbox wants: saying the same thing twice on purpose is a
   * thing people do.
   */
  async claimByKey(input: {
    dedupeKey: string | null;
    kind: string;
    body: string;
    to: string;
    channel?: "sms" | "email" | "in_app";
    customerId?: string | null;
    cleanerId?: string | null;
    leadId?: string | null;
    jobId?: string | null;
  }): Promise<string | null> {
    const { data, error } = await this.db.rpc("record_message", {
      p_dedupe_key: input.dedupeKey,
      p_kind: input.kind,
      p_channel: input.channel ?? "sms",
      p_body: input.body,
      p_to_address: input.to,
      p_customer_id: input.customerId ?? null,
      p_cleaner_id: input.cleanerId ?? null,
      p_lead_id: input.leadId ?? null,
      p_job_id: input.jobId ?? null,
    });
    if (error) throw new Error(`claimByKey: ${error.message}`);
    return typeof data === "string" ? data : null;
  }

  /** What the provider said. A failure is recorded, never swallowed. */
  async settle(
    messageId: string,
    providerId: string | null,
    failedReason: string | null = null,
  ): Promise<void> {
    const { error } = await this.db.rpc("settle_outbound_message", {
      p_message_id: messageId,
      p_provider_id: providerId,
      p_failed_reason: failedReason,
    });
    if (error) throw new Error(`settle: ${error.message}`);
  }

  /**
   * Who to text, for a set of cleaners.
   *
   * A cleaner has no phone of her own — the number lives on her `profiles` row,
   * which is also where an opt-out is recorded, so both come from one read.
   */
  async recipientsFor(cleanerIds: readonly string[]): Promise<Map<string, Recipient>> {
    const byCleaner = new Map<string, Recipient>();
    if (cleanerIds.length === 0) return byCleaner;

    const { data, error } = await this.db
      .from("cleaners")
      .select("id, full_name, profile_id, profiles ( id, phone, sms_opted_out_at )")
      .in("id", [...cleanerIds]);
    if (error) throw new Error(`recipientsFor: ${error.message}`);

    for (const row of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
      const id = row["id"];
      if (typeof id !== "string") continue;

      const profile = (row["profiles"] ?? {}) as Record<string, unknown>;
      const fullName = typeof row["full_name"] === "string" ? row["full_name"] : "";

      byCleaner.set(id, {
        cleanerId: id,
        profileId: typeof profile["id"] === "string" ? profile["id"] : null,
        // First name only. A text that opens with a full legal name reads like
        // a debt collector, not the company she works with.
        firstName: fullName.split(" ")[0] || "there",
        phone: typeof profile["phone"] === "string" ? profile["phone"] : null,
        optedOut: profile["sms_opted_out_at"] != null,
      });
    }
    return byCleaner;
  }

  /** STOP / START, from the inbound webhook. */
  async setOptOut(profileId: string, optedOut: boolean, reason: string | null): Promise<void> {
    const { error } = await this.db.rpc("set_sms_opt_out", {
      p_profile_id: profileId,
      p_opted_out: optedOut,
      p_reason: reason,
    });
    if (error) throw new Error(`setOptOut: ${error.message}`);
  }

  /**
   * STOP / START applied to the NUMBER, which is what the person meant.
   *
   * They are telling us to stop texting that handset. They are not telling us
   * which of our tables they appear in, and honouring it on the cleaner row but
   * not the customer one is both a carrier violation and, in her case, a quiet
   * penalty: offers she cannot see, expiring against her acceptance rate.
   *
   * Returns how many records were touched, which is how the webhook can say
   * "opted out, matched nobody" — a real case worth seeing in the log.
   */
  async setOptOutByPhone(
    phone: string,
    optedOut: boolean,
    reason: string | null,
  ): Promise<number> {
    const { data, error } = await this.db.rpc("set_sms_opt_out_by_phone", {
      p_phone: phone,
      p_opted_out: optedOut,
      p_reason: reason,
    });
    if (error) throw new Error(`setOptOutByPhone: ${error.message}`);
    return typeof data === "number" ? data : 0;
  }

  /**
   * Write down something that arrived.
   *
   * Returns null when this provider id has already been recorded, which the
   * webhook reads as "already have it" — answering anything but 200 to a
   * duplicate is how a retry storm starts.
   */
  async recordInbound(input: {
    providerId: string;
    from: string;
    to: string;
    body: string;
  }): Promise<string | null> {
    const { data, error } = await this.db.rpc("record_inbound_message", {
      p_provider_id: input.providerId,
      p_from_address: input.from,
      p_to_address: input.to,
      p_body: input.body,
      p_channel: "sms",
    });
    if (error) throw new Error(`recordInbound: ${error.message}`);
    return typeof data === "string" ? data : null;
  }
}

/**
 * Can this cleaner be told about an offer at all?
 *
 * Pure, and separate from the send path because DISPATCH needs to ask it before
 * writing an offer. Offering work to somebody unreachable starts a countdown
 * she cannot answer, and it expires having taught the ranking that she passed
 * on a job she was never shown.
 */
export type Reachability =
  | { reachable: true; phone: string }
  | { reachable: false; reason: "no_phone" | "opted_out" | "unknown_cleaner" };

export function reachabilityOf(recipient: Recipient | undefined): Reachability {
  if (!recipient) return { reachable: false, reason: "unknown_cleaner" };
  if (recipient.optedOut) return { reachable: false, reason: "opted_out" };
  if (!recipient.phone) return { reachable: false, reason: "no_phone" };
  return { reachable: true, phone: recipient.phone };
}
