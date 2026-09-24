import { NextResponse, type NextRequest } from "next/server";
import { SupabaseRepository } from "@/lib/data/supabase-repository";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  DispatchStore,
  availabilityFor,
  busyWindowsFor,
  managerOffersFor,
} from "@/lib/dispatch/store";
import { textOffer, wakeCleaner } from "@/lib/dispatch/notify";
import {
  MessagingStore,
  reachabilityOf,
  type Recipient,
} from "@/lib/messaging/store";
import { sendWindowFor } from "@/lib/messaging/quiet-hours";
import { isMessagingEnabled } from "@/lib/messaging/env";
import { PushStore } from "@/lib/push/store";
import { isPushEnabled } from "@/lib/push/vapid";
import { windowsOn } from "@/lib/dispatch/availability";
import { dispatchBoard, hoursUntil, type DispatchDecision } from "@/lib/dispatch/engine";
import { presentOffer } from "@/lib/dispatch/ladder";
import { CLEANER_SHARE_OF_TICKET, payoutForTicket } from "@/lib/pricing/payout";
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
  const messaging = new MessagingStore(db);

  // Time out lapsed countdowns FIRST. A job whose exclusive hold ran out
  // unanswered has to be seen as unheld, or the sweep keeps politely waiting
  // on somebody who never replied and the visit is never filled.
  const expired = await store.expireStaleOffers();

  const [allJobs, cleaners, managerOffers] = await Promise.all([
    repo.listJobs({ needingCleaner: true }),
    repo.listCleaners(),
    managerOffersFor(db),
  ]);

  // A job a manager has offered to one contractor is hers to answer. Deciding
  // it again here would offer it to others, or assign an employee over her.
  const jobs = allJobs.filter((j) => !managerOffers.has(j.id));

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

  // Who we can actually reach. An offer nobody is told about is not an offer:
  // it starts a countdown the cleaner cannot answer and expires having taught
  // the ranking she passed on work she was never shown.
  const recipients = await messaging.recipientsFor(cleaners.map((c) => c.id));

  /**
   * Devices to wake, alongside the text.
   *
   * BOTH GO OUT, and that is the point rather than an oversight. A cleaner who
   * has not installed the app to her home screen cannot receive a push at all —
   * on iOS that is most of them — and a marketplace that quietly stopped
   * offering work to whoever had not installed it would be a marketplace with a
   * silent supply problem nobody could see.
   *
   * The push is the fast half: an offer rung lives 8 to 15 minutes, a
   * notification arrives in seconds, and it costs nothing per send while a text
   * costs money every time a rung goes to a tier.
   */
  const pushStore = new PushStore(db);
  const pushTargets = isPushEnabled()
    ? await pushStore.targetsFor(cleaners.map((c) => c.id))
    : new Map<string, string[]>();

  const result = {
    jobs: jobs.length,
    heldByManager: allJobs.length - jobs.length,
    expiredOffers: expired,
    assigned: 0,
    held: 0,
    offered: 0,
    notified: 0,
    deferred: 0,
    unreachable: 0,
    refused: 0,
    unfilled: 0,
    pushed: 0,
    failed: 0,
  };
  const problems: { jobId: string; error: string }[] = [];

  for (const { job, decision } of dispatchBoard(jobs, context)) {
    try {
      // Recorded BEFORE anything is acted on, and recorded even when the
      // decision is "nobody". A board that only writes down its successes
      // cannot answer why a visit went unfilled for three days.
      const { id: decisionId } = await store.recordDecision(job.id, decision);
      await act(
        {
          store,
          messaging,
          recipients,
          origin: request.nextUrl.origin,
          pushStore,
          pushTargets,
          result,
        },
        job,
        decision,
        decisionId,
        now,
        result,
      );
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
  notified: number;
  deferred: number;
  unreachable: number;
  refused: number;
  unfilled: number;
  pushed: number;
};

interface Deps {
  store: DispatchStore;
  messaging: MessagingStore;
  recipients: Map<string, Recipient>;
  origin: string;
  pushStore: PushStore;
  pushTargets: Map<string, string[]>;
  result: Result;
}

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
): Promise<string | null> {
  try {
    const offerId = await store.recordOffer(offer);
    result.offered += 1;
    return offerId;
  } catch (error) {
    result.refused += 1;
    console.warn(
      `offer refused for cleaner ${offer.cleanerId} on job ${offer.jobId}: ${messageOf(error)}`,
    );
    return null;
  }
}

async function act(
  deps: Deps,
  job: Job,
  decision: DispatchDecision,
  decisionId: string,
  now: Date,
  result: Result,
): Promise<void> {
  const { store } = deps;

  switch (decision.kind) {
    case "assign_guaranteed":
    case "assign_w2": {
      // An employee is scheduled, not asked — and scheduled work needs no
      // countdown, so nothing here waits on being able to text her.
      const payout = payoutForTicket(job.priceCents, CLEANER_SHARE_OF_TICKET);
      if (await store.assignDirectly(job.id, decision.cleaner.id, payout)) result.assigned += 1;
      return;
    }

    case "hold_for_incumbent": {
      const sent = await offerAndNotify(deps, job, result, {
        cleanerId: decision.cleaner.id,
        decisionId,
        channel: "direct_assign",
        tier: 1,
        share: decision.share,
        payoutCents: decision.payoutCents,
        expiresAt: decision.exclusiveUntil,
        isExclusive: true,
        now,
      });
      if (sent) result.held += 1;
      return;
    }

    case "open_board": {
      for (const cleaner of decision.eligible) {
        await offerAndNotify(deps, job, result, {
          cleanerId: cleaner.id,
          decisionId,
          channel: "open_board",
          tier: 1,
          share: decision.share,
          payoutCents: decision.payoutCents,
          expiresAt: decision.promoteToWaterfallAt,
          isExclusive: false,
          now,
        });
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
        await offerAndNotify(deps, job, result, {
          cleanerId: cleaner.id,
          decisionId,
          channel: "waterfall",
          tier: 1,
          share: rung.share,
          payoutCents: rung.payoutCents,
          expiresAt: presented.expiresAt,
          isExclusive: false,
          now,
        });
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

interface OfferPlan {
  cleanerId: string;
  decisionId: string;
  channel: "open_board" | "waterfall" | "direct_assign";
  tier: number;
  share: number;
  payoutCents: number;
  expiresAt: Date;
  isExclusive: boolean;
  now: Date;
}

/**
 * Write an offer and tell the cleaner it exists — or write neither.
 *
 * THE ORDER MATTERS AND SO DOES THE REFUSAL. An offer she cannot be told about
 * is worse than no offer: it starts a countdown she has no way to answer, and
 * when it lapses the system records that she passed on work she was never
 * shown. Acceptance rate drives ranking, so that is not a cosmetic error — it
 * is her standing in the marketplace, spent on a message we never sent.
 *
 * So both gates are checked BEFORE the offer is written:
 *
 *   * REACHABILITY — no number on file, or she has replied STOP.
 *   * THE SEND WINDOW — quiet hours, unless the job is close enough that
 *     waiting until morning is the worse outcome.
 *
 * A deferred job is not lost. The sweep runs hourly; the next one after 08:00
 * writes the offer and sends it.
 */
async function offerAndNotify(
  deps: Deps,
  job: Job,
  result: Result,
  plan: OfferPlan,
): Promise<boolean> {
  const recipient = deps.recipients.get(plan.cleanerId);
  const reach = reachabilityOf(recipient);

  // Messaging switched off entirely — a local run, or a demo. Offers are still
  // written, because the alternative is a dev environment where dispatch
  // silently does nothing.
  const announcing = isMessagingEnabled();

  if (announcing && !reach.reachable) {
    result.unreachable += 1;
    return false;
  }

  if (announcing) {
    const window = sendWindowFor(plan.now, {
      hoursUntilJob: hoursUntil(job, plan.now),
    });
    if (!window.send) {
      result.deferred += 1;
      return false;
    }
  }

  const offerId = await tryOffer(
    deps.store,
    {
      jobId: job.id,
      cleanerId: plan.cleanerId,
      decisionId: plan.decisionId,
      channel: plan.channel,
      tier: plan.tier,
      share: plan.share,
      payoutCents: plan.payoutCents,
      estimatedMinutes: job.estimatedCleanMinutes,
      expiresAt: plan.expiresAt,
      isExclusive: plan.isExclusive,
    },
    result,
  );
  // The offer exists now, so wake her devices whatever happens with the text.
  // Deliberately before the SMS: the push is the fast half, and a Twilio
  // timeout should not delay it by ten seconds.
  if (offerId) deps.result.pushed += await wakeCleaner(deps, plan.cleanerId);

  if (!offerId || !announcing || !reach.reachable || !recipient) return Boolean(offerId);

  const sent = await textOffer(deps, {
    offerId,
    job,
    cleanerId: plan.cleanerId,
    recipient,
    phone: reach.phone,
    payoutCents: plan.payoutCents,
    expiresAt: plan.expiresAt,
    isExclusive: plan.isExclusive,
  });
  if (sent) result.notified += 1;
  return true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "dispatch failed";
}
