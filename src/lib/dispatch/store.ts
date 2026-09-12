import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DispatchDecision } from "./engine";
import type { ContinuityContext } from "./continuity";
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

  /**
   * Assign a W-2 cleaner directly, with no offer and no countdown.
   *
   * This is what employment IS: an employee is scheduled, not asked. The
   * mirror of it is that a contractor is never assigned this way — she gets an
   * offer she can decline, and a platform that skips that step is exercising
   * the control that makes her an employee whatever the paperwork says. The
   * engine enforces the split; this only executes it.
   *
   * Returns false when the job was claimed between the decision and the write,
   * which the sweep treats as an ordinary outcome rather than a failure.
   */
  async assignDirectly(
    jobId: string,
    cleanerId: string,
    payoutCents: number,
  ): Promise<boolean> {
    const { data, error } = await this.db.rpc("assign_job_directly", {
      p_job_id: jobId,
      p_cleaner_id: cleanerId,
      p_payout_cents: payoutCents,
    });
    if (error) throw new Error(`assignDirectly: ${error.message}`);
    return data === true;
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

/**
 * Continuity inputs for a set of jobs, from the `job_continuity` view.
 *
 * Fetched for the whole sweep in one query rather than per job: the board runs
 * over every unfilled visit in the horizon, and one query beats N.
 */
export async function continuityFor(
  db: SupabaseClient,
  jobIds: readonly string[],
): Promise<Map<string, ContinuityContext>> {
  const byJob = new Map<string, ContinuityContext>();
  if (jobIds.length === 0) return byJob;

  const { data, error } = await db
    .from("job_continuity")
    .select(
      "job_id, preferred_cleaner_id, incumbent_cleaner_id, prior_visits, agreed_payout_rate_cents",
    )
    .in("job_id", [...jobIds]);
  if (error) throw new Error(`continuityFor: ${error.message}`);

  for (const row of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    const jobId = row["job_id"];
    if (typeof jobId !== "string") continue;

    const preferred = row["preferred_cleaner_id"];
    const incumbent = row["incumbent_cleaner_id"];
    const agreedRate = row["agreed_payout_rate_cents"];
    byJob.set(jobId, {
      preferredCleanerId: typeof preferred === "string" ? preferred : null,
      incumbentCleanerId: typeof incumbent === "string" ? incumbent : null,
      priorVisits: typeof row["prior_visits"] === "number" ? row["prior_visits"] : 0,
      agreedPayoutRateCents: typeof agreedRate === "number" ? agreedRate : null,
    });
  }
  return byJob;
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

/**
 * What each cleaner is already committed to, over the window the board covers.
 *
 * The engine has always had a slot for this and no caller ever filled it, so
 * the `already_booked` check never fired in production. The database has been
 * catching the overlap all along — `cleaner_is_eligible` is enforced as a
 * CHECK on offers — but catching it there means the offer write RAISES, which
 * is a poor way to discover that a cleaner is busy: one clash would abort the
 * rest of that job's offers.
 *
 * So the engine is told first, and the CHECK goes back to being the backstop
 * it was meant to be rather than the only line of defence.
 */
export async function busyWindowsFor(
  db: SupabaseClient,
  from: Date,
  to: Date,
): Promise<Map<string, TimeWindow[]>> {
  const { data, error } = await db
    .from("job_assignments")
    .select("cleaner_id, jobs!inner ( scheduled_start, scheduled_end, estimated_clean_minutes, status )")
    .gte("jobs.scheduled_start", from.toISOString())
    .lte("jobs.scheduled_start", to.toISOString())
    .in("jobs.status", ["scheduled", "assigned", "in_progress"]);
  if (error) throw new Error(`busyWindowsFor: ${error.message}`);

  const byCleaner = new Map<string, TimeWindow[]>();
  for (const row of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    const cleanerId = row["cleaner_id"];
    const job = (row["jobs"] ?? {}) as Record<string, unknown>;
    if (typeof cleanerId !== "string") continue;

    const start = toDate(job["scheduled_start"]);
    if (!start) continue;

    // An end time if the job has one, otherwise the estimate. A job with
    // neither is treated as a point in time rather than skipped: it still
    // means she is somewhere at that moment.
    const minutes = typeof job["estimated_clean_minutes"] === "number"
      ? job["estimated_clean_minutes"]
      : 0;
    const end = toDate(job["scheduled_end"]) ?? new Date(start.getTime() + minutes * 60_000);

    const existing = byCleaner.get(cleanerId);
    if (existing) existing.push({ start, end });
    else byCleaner.set(cleanerId, [{ start, end }]);
  }
  return byCleaner;
}

/** A cleaner's declared working hours, by day of week (0 = Sunday). */
export type WeeklyAvailability = Map<string, Map<number, { startsAt: string; endsAt: string }[]>>;

/**
 * Declared availability for the whole roster.
 *
 * A cleaner with NO rows is absent from the map entirely, and the engine reads
 * that as unknown rather than as "works no hours" — see the note on
 * `EligibilityContext.workingWindows`. Nobody has declared anything yet, and a
 * check that read silence as refusal would empty the board on the day it
 * shipped.
 */
export async function availabilityFor(db: SupabaseClient): Promise<WeeklyAvailability> {
  const { data, error } = await db
    .from("cleaner_availability")
    .select("cleaner_id, day_of_week, starts_at, ends_at");
  if (error) throw new Error(`availabilityFor: ${error.message}`);

  const byCleaner: WeeklyAvailability = new Map();
  for (const row of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    const cleanerId = row["cleaner_id"];
    const day = row["day_of_week"];
    const startsAt = row["starts_at"];
    const endsAt = row["ends_at"];
    if (typeof cleanerId !== "string" || typeof day !== "number") continue;
    if (typeof startsAt !== "string" || typeof endsAt !== "string") continue;

    const days = byCleaner.get(cleanerId) ?? new Map();
    const windows = days.get(day) ?? [];
    windows.push({ startsAt, endsAt });
    days.set(day, windows);
    byCleaner.set(cleanerId, days);
  }
  return byCleaner;
}

function toDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface PassedOver {
  cleanerId: string;
  hourlyRateCents: number;
}

/**
 * Who has already been asked about each of these jobs, at what rate, and did
 * not take it.
 *
 * DECLINED AND EXPIRED BOTH COUNT. The sweep runs hourly and the engine is
 * stateless, so without this it re-asks the same cleaner the same question
 * every hour until the visit happens. For an incumbent it is worse than
 * repetitive: an unanswered exclusive hold would renew itself on every sweep
 * and the visit would never reach the open board. A hold that cannot lapse is
 * not a hold.
 *
 * WITHDRAWN is deliberately excluded. That is not her answer — it means
 * somebody else took the job, or we pulled the offer — and holding it against
 * her would punish a cleaner for a race she lost.
 *
 * The RATE is carried rather than a bare "asked already", because asking again
 * higher up is legitimate and is the entire mechanism of the ladder.
 */
export async function passedOverFor(
  db: SupabaseClient,
  jobIds: readonly string[],
): Promise<Map<string, PassedOver[]>> {
  const byJob = new Map<string, PassedOver[]>();
  if (jobIds.length === 0) return byJob;


  const { data, error } = await db
    .from("offers")
    .select("job_id, cleaner_id, hourly_rate_cents")
    .in("job_id", [...jobIds])
    .in("status", ["declined", "expired"]);
  if (error) throw new Error(`passedOverFor: ${error.message}`);

  for (const row of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    const jobId = row["job_id"];
    const cleanerId = row["cleaner_id"];
    const rate = row["hourly_rate_cents"];
    if (typeof jobId !== "string" || typeof cleanerId !== "string") continue;

    const entry = { cleanerId, hourlyRateCents: typeof rate === "number" ? rate : 0 };
    const existing = byJob.get(jobId);
    if (existing) existing.push(entry);
    else byJob.set(jobId, [entry]);
  }
  return byJob;
}

/**
 * The highest hourly rate each job has already been offered at.
 *
 * Read from EVERY offer, whatever became of it — the question is how far up
 * the ladder this job has been carried, and an offer that expired carried it
 * just as far as one that was declined.
 */
export async function offeredUpToFor(
  db: SupabaseClient,
  jobIds: readonly string[],
): Promise<Map<string, number>> {
  const byJob = new Map<string, number>();
  if (jobIds.length === 0) return byJob;

  const { data, error } = await db
    .from("offers")
    .select("job_id, hourly_rate_cents")
    .in("job_id", [...jobIds]);
  if (error) throw new Error(`offeredUpToFor: ${error.message}`);

  for (const row of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    const jobId = row["job_id"];
    const rate = row["hourly_rate_cents"];
    if (typeof jobId !== "string" || typeof rate !== "number") continue;
    byJob.set(jobId, Math.max(byJob.get(jobId) ?? 0, rate));
  }
  return byJob;
}
