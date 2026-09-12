import { NextResponse, type NextRequest } from "next/server";
import { SupabaseRepository } from "@/lib/data/supabase-repository";
import { createAdminClient } from "@/lib/supabase/admin";
import { DispatchStore, availabilityFor, busyWindowsFor } from "@/lib/dispatch/store";
import { windowsOn } from "@/lib/dispatch/availability";
import { dispatchBoard, type DispatchDecision } from "@/lib/dispatch/engine";
import { OPENING_RATE_CENTS_PER_HOUR, payoutForRate, presentOffer } from "@/lib/dispatch/ladder";
import { zipCentroidEstimator } from "@/lib/dispatch/route";
import { ZIP_CENTROIDS } from "@/lib/config";
import { cronSecretMatches } from "@/lib/stripe/env";
import type { Cleaner, DispatchJob } from "@/lib/dispatch/types";
import type { Job } from "@/lib/data/types";

/**
 * The dispatch sweep: turn decisions into offers.
 *
 * This is the link the service loop was missing. The engine has always been
 * able to decide who should get a job; until now it did so while drawing the
 * admin board and the answer was discarded when the request ended, so nothing
 * was ever offered and nothing could be accepted.
 *
 * Guarded by CRON_SECRET like the recurring and auto-charge sweeps — it runs
 * with no signed-in user, so a session guard would have nobody to check.
 *
 * Safe to run repeatedly. `record_offer` is idempotent while an offer is live,
 * so a job already out with a cleaner is re-presented rather than re-offered,
 * and a job somebody has already taken is skipped.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const estimate = zipCentroidEstimator(ZIP_CENTROIDS);

export async function POST(request: NextRequest) {
  const presented =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;

  if (!cronSecretMatches(presented)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const repo = new SupabaseRepository(db);
  const store = new DispatchStore(db);

  // Time out lapsed countdowns FIRST. A job whose exclusive hold ran out
  // unanswered has to be seen as unheld, or the sweep keeps politely waiting
  // on somebody who never replied and the visit is never filled.
  const expired = await store.expireStaleOffers();

  const [jobs, cleaners] = await Promise.all([
    repo.listJobs({ needingCleaner: true }),
    repo.listCleaners(),
  ]);

  const now = new Date();

  // The window the board covers, for the double-booking check. Bounded by the
  // furthest job rather than a fixed horizon, so a plan generating six weeks
  // ahead does not quietly fall outside it.
  const latest = jobs.reduce(
    (max, j) => (j.scheduledStart && j.scheduledStart > max ? j.scheduledStart : max),
    now,
  );

  // `listJobs` already attaches continuity and declines, so the board and this
  // sweep cannot disagree about a job.
  const [busy, availability] = await Promise.all([
    busyWindowsFor(db, now, new Date(latest.getTime() + 24 * 3_600_000)),
    availabilityFor(db),
  ]);

  const context = {
    now,
    cleaners,
    driveFor: (c: Cleaner, j: DispatchJob) => estimate(c.lastStopZip, j.zip),
    /**
     * The gate's own inputs, which had never had a caller — so neither the
     * double-booking check nor working hours had any effect in production.
     *
     * The database has been catching overlaps all along, as a CHECK on the
     * offers table, but catching it THERE means the offer write raises: one
     * busy cleaner would abort the rest of that job's offers. Telling the
     * engine first puts the CHECK back to being the backstop it was designed
     * as.
     */
    eligibilityFor: (c: Cleaner, j: DispatchJob) => ({
      busyWindows: busy.get(c.id) ?? [],
      jobDurationMinutes: j.estimatedCleanMinutes,
      workingWindows: j.scheduledStart
        ? windowsOn(j.scheduledStart, availability.get(c.id))
        : undefined,
    }),
    // Familiarity in the ranking, which was always zero in production because
    // nothing ever supplied this hook.
    priorJobsFor: (c: Cleaner, j: DispatchJob) =>
      j.continuity && j.continuity.incumbentCleanerId === c.id ? j.continuity.priorVisits : 0,
  };

  const result = {
    jobs: jobs.length,
    expiredOffers: expired,
    assigned: 0,
    held: 0,
    offered: 0,
    refused: 0,
    unfilled: 0,
    failed: 0,
  };
  const problems: { jobId: string; error: string }[] = [];

  for (const { job, decision } of dispatchBoard(jobs, context)) {
    try {
      // Recorded BEFORE anything is acted on, and recorded even when the
      // decision is "nobody". A board that only writes down its successes
      // cannot answer why a visit went unfilled for three days.
      const { id: decisionId } = await store.recordDecision(job.id, decision);
      await act(store, job, decision, decisionId, now, result);
    } catch (error) {
      // One job must not stop the board. A visit that fails to dispatch is a
      // problem for a person; every other visit still needs filling tonight.
      result.failed += 1;
      problems.push({ jobId: job.id, error: messageOf(error) });
      console.error(`dispatch failed for job ${job.id}`, error);
    }
  }

  return NextResponse.json(problems.length > 0 ? { ...result, problems } : result);
}

type Result = {
  assigned: number;
  held: number;
  offered: number;
  refused: number;
  unfilled: number;
};

/**
 * Write one offer, treating a refusal as one cleaner's problem rather than the
 * job's.
 *
 * The eligibility gate is a CHECK on the offers table, so an offer the engine
 * thought was fine can still be refused by the database — the engine works
 * from a roster read at the top of the sweep, and a cleaner who accepted
 * something else thirty seconds ago has moved on since. Letting that abort the
 * whole job would mean one cleaner going busy costs every other cleaner their
 * look at the work.
 */
async function tryOffer(
  store: DispatchStore,
  offer: Parameters<DispatchStore["recordOffer"]>[0],
  result: Result,
): Promise<void> {
  try {
    await store.recordOffer(offer);
    result.offered += 1;
  } catch (error) {
    result.refused += 1;
    console.warn(
      `offer refused for cleaner ${offer.cleanerId} on job ${offer.jobId}: ${messageOf(error)}`,
    );
  }
}

async function act(
  store: DispatchStore,
  job: Job,
  decision: DispatchDecision,
  decisionId: string,
  now: Date,
  result: Result,
): Promise<void> {
  switch (decision.kind) {
    case "assign_guaranteed":
    case "assign_w2": {
      // An employee is scheduled, not asked.
      const payout = payoutForRate(OPENING_RATE_CENTS_PER_HOUR, job.estimatedCleanMinutes);
      if (await store.assignDirectly(job.id, decision.cleaner.id, payout)) result.assigned += 1;
      return;
    }

    case "hold_for_incumbent": {
      await store.recordOffer({
        jobId: job.id,
        cleanerId: decision.cleaner.id,
        decisionId,
        channel: "direct_assign",
        tier: 1,
        hourlyRateCents: decision.hourlyRateCents,
        payoutCents: decision.payoutCents,
        estimatedMinutes: job.estimatedCleanMinutes,
        expiresAt: decision.exclusiveUntil,
        isExclusive: true,
      });
      result.held += 1;
      return;
    }

    case "open_board": {
      // The board is not a broadcast to everyone at once in practice — it is
      // an offer to each eligible cleaner at the same standing rate, which is
      // what makes "first to claim it" true rather than a race the fastest
      // phone wins.
      for (const cleaner of decision.eligible) {
        await tryOffer(
          store,
          {
            jobId: job.id,
            cleanerId: cleaner.id,
            decisionId,
            channel: "open_board",
            tier: 1,
            hourlyRateCents: decision.hourlyRateCents,
            payoutCents: decision.payoutCents,
            estimatedMinutes: job.estimatedCleanMinutes,
            expiresAt: decision.promoteToWaterfallAt,
          },
          result,
        );
      }
      return;
    }

    case "waterfall": {
      // ONLY THE FIRST RUNG GOES OUT NOW. The ladder is a schedule, not a
      // broadcast: writing every rung would put the highest payout on a
      // cleaner's screen immediately and hand away the entire benefit of
      // escalating. The next sweep sends the next rung to the next tier once
      // this one has lapsed.
      const rung = decision.ladder[0];
      const tier = decision.tiers[0];
      if (!rung || !tier) {
        result.unfilled += 1;
        return;
      }

      const presented = presentOffer(job, rung, now);
      for (const cleaner of tier) {
        await tryOffer(
          store,
          {
            jobId: job.id,
            cleanerId: cleaner.id,
            decisionId,
            channel: "waterfall",
            tier: 1,
            hourlyRateCents: rung.hourlyRateCents,
            payoutCents: rung.payoutCents,
            estimatedMinutes: job.estimatedCleanMinutes,
            expiresAt: presented.expiresAt,
          },
          result,
        );
      }
      return;
    }

    case "no_eligible_cleaner":
      // Nothing to do, and the decision row already says so. This is the line
      // the exception queue is built from: a visit no cleaner can take is the
      // one case that always needs a person.
      result.unfilled += 1;
      return;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "dispatch failed";
}
