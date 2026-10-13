import type { DispatchJob } from "./types";

/** Match the database's half-open visit window; a stored valid end takes precedence. */
export function matchingWindow(job: DispatchJob, durationMinutes = job.estimatedCleanMinutes) {
  const start = job.scheduledStart;
  if (!start || !Number.isFinite(start.getTime())) return null;
  if (job.scheduledEnd && !Number.isFinite(job.scheduledEnd.getTime())) return null;
  const minutes = Math.max(durationMinutes, 1);
  const end = job.scheduledEnd && job.scheduledEnd > start
    ? job.scheduledEnd : new Date(start.getTime() + minutes * 60_000);
  return Number.isFinite(end.getTime()) ? { start, end } : null;
}
