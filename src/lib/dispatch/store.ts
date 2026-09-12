import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DispatchDecision } from "./engine";
import type { DispatchChannel } from "./types";

/**
 * Persisting what dispatch decided, and what cleaners did about it.
 *
 * Same division as billing and recurring: the decisions are made by pure
 * functions in engine.ts, continuity.ts and ladder.ts, and this only writes
 * them down. Nothing here works out who should get a job.
 *
 * Service-role, like BillingStore and RecurringStore, because dispatch runs on
 * a sweep with no signed-in user — and because the accept path must write an
 * assignment at a payout the CLEANER is not allowed to choose. 0007 took the
 * cleaner's UPDATE permission on offers away for exactly that reason; routing
 * the response through here and through `respond_to_offer` is what replaces
 * it.
 */

/** What `respond_to_offer` reports. Every one is an ordinary outcome. */
export type OfferResponse =
  | "accepted"
  | "declined"
  | "taken"
  | "expired"
  | "superseded"
  | "not_found";

export interface RecordedDecision {
  id: string;
  jobId: string;
}

export interface OfferToRecord {
  jobId: string;
  cleanerId: string;
  decisionId: string | null;
  channel: DispatchChannel;
  tier: number;
  hourlyRateCents: number;
  payoutCents: number;
  estimatedMinutes: number;
  expiresAt: Date;
  isExclusive?: boolean;
}

export class DispatchStore {
  constructor(private readonly db: SupabaseClient) {}

  /**
   * Write the decision.
   *
   * `decidedBy` is the intervention marker: null when the engine decided by
   * itself, and the acting profile when a person did. It is the numerator of
   * "manager interventions per 100 completed cleans", so passing a profile id
   * for an automated run would quietly corrupt the one metric the whole
   * platform is steering by.
   */
  async recordDecision(
    jobId: string,
    decision: DispatchDecision,
    decidedBy: string | null = null,
  ): Promise<RecordedDecision> {
    const continuity = decision.continuity;

    const { data, error } = await this.db
      .from("dispatch_decisions")
      .insert({
        job_id: jobId,
        kind: decision.kind,
        cleaner_id: cleanerOf(decision),
        continuity_status: continuity.status,
        continuity_basis: continuity.status === "none" ? null : continuity.basis,
        continuity_reason: continuity.status === "none" ? continuity.reason : null,
        continuity_premium_cents:
          continuity.status === "none" ? null : (continuity.premiumCents ?? null),
        marginal_cents: marginalOf(decision),
        w2_ceiling_cents: decision.kind === "waterfall" ? decision.w2CeilingCents : null,
        rationale: decision.rationale,
        decided_by: decidedBy,
      })
      .select("id, job_id")
      .single();

    if (error) throw new Error(`recordDecision: ${error.message}`);
    const row = data as Record<string, unknown>;
    return { id: String(row["id"]), jobId: String(row["job_id"]) };
  }

  /**
   * Send an offer. Returns the offer id — the existing one if this cleaner
   * already has a live offer on this job, which is what makes a re-run of the
   * sweep harmless rather than a second acceptable offer.
   */
  async recordOffer(offer: OfferToRecord): Promise<string | null> {
    const { data, error } = await this.db.rpc("record_offer", {
      p_job_id: offer.jobId,
      p_cleaner_id: offer.cleanerId,
      p_decision_id: offer.decisionId,
      p_channel: offer.channel,
      p_tier: offer.tier,
      p_hourly_rate_cents: offer.hourlyRateCents,
      p_payout_cents: offer.payoutCents,
      p_estimated_minutes: offer.estimatedMinutes,
      p_expires_at: offer.expiresAt.toISOString(),
      p_is_exclusive: offer.isExclusive ?? false,
    });
    if (error) throw new Error(`recordOffer: ${error.message}`);
    return typeof data === "string" ? data : null;
  }

  /**
   * Accept or decline. The payout is not a parameter here and must never
   * become one — it is read from the offer row inside the function.
   */
  async respond(
    offerId: string,
    cleanerId: string,
    accept: boolean,
    reason: string | null = null,
  ): Promise<OfferResponse> {
    const { data, error } = await this.db.rpc("respond_to_offer", {
      p_offer_id: offerId,
      p_cleaner_id: cleanerId,
      p_accept: accept,
      p_reason: reason,
    });
    if (error) throw new Error(`respond: ${error.message}`);
    return isOfferResponse(data) ? data : "not_found";
  }

  /** Time out every countdown that has run down. Returns how many. */
  async expireStaleOffers(): Promise<number> {
    const { data, error } = await this.db.rpc("expire_stale_offers");
    if (error) throw new Error(`expireStaleOffers: ${error.message}`);
    return typeof data === "number" ? data : 0;
  }
}

function cleanerOf(decision: DispatchDecision): string | null {
  switch (decision.kind) {
    case "assign_guaranteed":
    case "assign_w2":
    case "hold_for_incumbent":
      return decision.cleaner.id;
    default:
      return null;
  }
}

function marginalOf(decision: DispatchDecision): number | null {
  switch (decision.kind) {
    case "assign_guaranteed":
    case "assign_w2":
      return decision.marginalCents;
    default:
      return null;
  }
}

const RESPONSES: readonly string[] = [
  "accepted",
  "declined",
  "taken",
  "expired",
  "superseded",
  "not_found",
];

function isOfferResponse(value: unknown): value is OfferResponse {
  return typeof value === "string" && RESPONSES.includes(value);
}
