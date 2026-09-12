import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { RecurringStore } from "@/lib/recurring/store";
import { DEFAULT_HORIZON_DAYS, occurrencesBetween } from "@/lib/recurring/schedule";
import { addCalendarDays, todayIn } from "@/lib/time/zone";
import { cronSecretMatches } from "@/lib/stripe/env";

/**
 * The recurring sweep: turn plans into visits.
 *
 * Runs on a schedule with no signed-in user, so it is guarded by CRON_SECRET
 * exactly as the auto-charge sweep is — a session guard would have nobody to
 * check.
 *
 * This route decides nothing about WHEN. `occurrencesBetween` does that,
 * purely and tested without a database, and this materialises what it
 * returns. Running it twice is a no-op: `materialise_recurring_job` is
 * guarded by a unique index on (plan, occurrence date), which is what makes
 * a double-run safe and a double booking impossible.
 *
 * Safe to run daily, hourly, or by hand. It is expected to do almost nothing
 * most of the time — a six-week horizon means every visit is seen dozens of
 * times before it happens.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const presented =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;

  if (!cronSecretMatches(presented)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const store = new RecurringStore(createAdminClient());
  const plans = await store.listActivePlans();

  // Today where the business is, not where the server is. A sweep running at
  // 01:00 UTC is still "yesterday" in Dallas, and generating from the wrong
  // day would put a visit on the board a day early every night.
  const today = todayIn();

  const result = {
    plans: plans.length,
    created: 0,
    existing: 0,
    skipped: 0,
    shifted: 0,
    failed: 0,
  };
  const problems: { planId: string; error: string }[] = [];

  for (const plan of plans) {
    try {
      const horizon = addCalendarDays(today, plan.horizonDays || DEFAULT_HORIZON_DAYS);

      for (const occurrence of occurrencesBetween(plan, today, horizon)) {
        const { jobId, created } = await store.materialise(
          plan.id,
          occurrence.date,
          occurrence.startsAt,
        );

        if (jobId === null) {
          // The occurrence is called off. Not a failure — the commonest
          // reason a plan produces fewer visits than its cadence suggests.
          result.skipped += 1;
          continue;
        }
        if (occurrence.shiftedForDaylightSaving) result.shifted += 1;

        // `created` and `existing` are different facts and both matter. A
        // sweep over a six-week horizon re-sees almost every visit dozens of
        // times before it happens, so counting those as creations made the
        // one autonomous loop in the system look about forty times busier
        // than it is — and made a run that genuinely created nothing
        // indistinguishable from a healthy one.
        if (created) result.created += 1;
        else result.existing += 1;
      }
    } catch (error) {
      // One broken plan must not stop the book. A plan with a corrupted
      // anchor or an unusable start time is a data problem for a person;
      // every other customer's visits still need generating tonight.
      result.failed += 1;
      problems.push({ planId: plan.id, error: messageOf(error) });
      console.error(`recurring generation failed for plan ${plan.id}`, error);
    }
  }

  return NextResponse.json(problems.length > 0 ? { ...result, problems } : result);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "generation failed";
}
