export interface AutomationRecord {
  id: string;
  outcome: string | null;
  error: string | null;
  fired_at: string | null;
  scheduled_for: string | null;
}
/** Respect intentional skips. Only delivery failures and overdue work need attention. */
export function automationState(
  row: AutomationRecord,
  now: Date,
): "sent" | "stopped" | "overdue" | "waiting" | "skipped" {
  if (row.outcome === "sent") return "sent";
  if (
    row.outcome === "failed" ||
    row.error?.startsWith("not retryable") ||
    row.error === "gave up after repeated failures" ||
    row.error === "messaging is disabled" ||
    row.error === "no phone on file"
  )
    return "stopped";
  if (row.fired_at) return "skipped";
  const scheduled = row.scheduled_for
    ? new Date(row.scheduled_for).getTime()
    : NaN;
  // Existing sweeps run hourly and can be delayed. Do not flag work as late immediately.
  return Number.isFinite(scheduled) &&
    scheduled < now.getTime() - 90 * 60 * 1000
    ? "overdue"
    : "waiting";
}
