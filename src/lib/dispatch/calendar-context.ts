import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DispatchContext } from "./engine";
import type { DispatchJob } from "./types";
import { availabilityFor, busyWindowsFor, scheduledHoursByWeek } from "./store";
import { windowsOn } from "./availability";
import { matchingWindow } from "./window";
import { matchingWeek } from "./week";

/** Shared saved calendar inputs for Management recommendations and the sweep. */
export async function matchingCalendarInputs(db: SupabaseClient, jobs: readonly DispatchJob[], now: Date):
  Promise<Pick<DispatchContext, "eligibilityFor" | "priorJobsFor" | "scheduledHoursFor">> {
  const latest = jobs.reduce((max, job) => {
    const end = matchingWindow(job)?.end;
    return end && end > max ? end : max;
  }, new Date(now.getTime() + 60_000));
  const weeks = [...new Set([matchingWeek(now), ...jobs.filter(j => j.scheduledStart && Number.isFinite(j.scheduledStart.getTime()))
    .map(j => matchingWeek(j.scheduledStart!))])];
  const [busy, availability, hours] = await Promise.all([
    busyWindowsFor(db, now, latest), availabilityFor(db), scheduledHoursByWeek(db, weeks),
  ]);
  return {
    scheduledHoursFor: (cleaner, week) => hours.get(week)?.get(cleaner.id) ?? 0,
    eligibilityFor: (cleaner, job) => ({
      busyWindows: busy.get(cleaner.id) ?? [],
      workingWindows: job.scheduledStart && Number.isFinite(job.scheduledStart.getTime())
        ? windowsOn(job.scheduledStart, availability.get(cleaner.id)) : undefined,
    }),
    priorJobsFor: (cleaner, job) =>
      job.continuity?.incumbentCleanerId === cleaner.id ? job.continuity.priorVisits : 0,
  };
}
