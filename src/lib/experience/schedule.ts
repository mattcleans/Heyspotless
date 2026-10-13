import type { Job } from "@/lib/data/types";
import { BUSINESS_TIME_ZONE, todayIn } from "@/lib/time/zone";

const CLOSED = new Set(["complete", "canceled"]);
/** Keep unresolved past visits visible without presenting them as future bookings. */
export function visitSections(jobs: readonly Job[], now: Date) {
  const active = activeVisits(jobs);
  return {
    ongoing: active.filter((job) => job.status === "in_progress"),
    upcoming: active.filter((job) => job.status !== "in_progress" && job.scheduledStart && job.scheduledStart >= now),
    awaitingTime: active.filter((job) => job.status !== "in_progress" && !job.scheduledStart),
    unresolved: active.filter((job) => job.status !== "in_progress" && job.scheduledStart && job.scheduledStart < now),
    history: jobs.filter((job) => CLOSED.has(job.status)).sort((a, b) => (b.scheduledStart?.getTime() ?? 0) - (a.scheduledStart?.getTime() ?? 0)),
  };
}
export function upcomingVisits(jobs: readonly Job[], now: Date): Job[] {
  return activeVisits(jobs).filter(
    (job) => job.status === "in_progress" || !job.scheduledStart || job.scheduledStart >= now,
  );
}
export function activeVisits(jobs: readonly Job[]): Job[] {
  return jobs
    .filter((job) => !CLOSED.has(job.status))
    .sort(
      (a, b) =>
        Number(b.status === "in_progress") -
          Number(a.status === "in_progress") ||
        (a.scheduledStart?.getTime() ?? Infinity) -
          (b.scheduledStart?.getTime() ?? Infinity),
    );
}

/** Preserve appointment order. Geographic optimization must not move a booked time. */
export function visitsOnDay(
  jobs: readonly Job[],
  now: Date,
  zone = BUSINESS_TIME_ZONE,
): Job[] {
  const day = todayIn(zone, now);
  return jobs
    .filter(
      (job) =>
        job.status !== "canceled" &&
        job.scheduledStart &&
        todayIn(zone, job.scheduledStart) === day,
    )
    .sort((a, b) => a.scheduledStart!.getTime() - b.scheduledStart!.getTime());
}

export function attentionVisits(jobs: readonly Job[], now: Date): Job[] {
  return activeVisits(jobs).filter(
    (job) =>
      !job.scheduledStart ||
      (job.status !== "in_progress" && job.scheduledStart < now) ||
      (["unscheduled", "scheduled", "dispatching"].includes(job.status) &&
        job.scheduledStart.getTime() <= now.getTime() + 24 * 60 * 60 * 1000),
  );
}

export function attentionReason(job: Job, now: Date): string {
  if (!job.scheduledStart) return "Choose a visit time";
  if (job.scheduledStart < now) return "Check the visit status";
  return "Confirm a cleaner before the visit";
}

export const JOB_LABELS: Record<string, string> = {
  unscheduled: "Time needed",
  scheduled: "Matching a cleaner",
  dispatching: "Matching a cleaner",
  assigned: "Cleaner assigned",
  in_progress: "Cleaning now",
  complete: "Complete",
  canceled: "Canceled",
};
