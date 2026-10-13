export interface MatchingHealth {
  observed_at: string;
  state_present: boolean;
  scheduler_count: number;
  scheduler_enabled: boolean;
  expected_interval: boolean;
  scheduler_status: string | null;
  scheduler_started_at: string | null;
  scheduler_finished_at: string | null;
  last_status: "idle" | "running" | "success" | "failed";
  last_started_at: string | null;
  last_finished_at: string | null;
  leased_until: string | null;
  last_result: Partial<Record<"jobs" | "assigned" | "offered" | "needsScheduling" | "failed", number>>;
}
const time = (value: unknown) => typeof value === "string" ? new Date(value).getTime() : NaN;
/** Unusable reads cannot produce a healthy badge or invented activity totals. */
export function readMatchingHealth(value: unknown): MatchingHealth | null {
  if (!value || typeof value !== "object") return null;
  const r=value as Record<string,unknown>;
  if (!Number.isFinite(time(r.observed_at)) || typeof r.state_present!=="boolean"
    || !Number.isInteger(r.scheduler_count) || (r.scheduler_count as number)<0
    || typeof r.scheduler_enabled!=="boolean" || typeof r.expected_interval!=="boolean"
    || !["idle","running","success","failed"].includes(String(r.last_status))) return null;
  for (const key of ["scheduler_status","scheduler_started_at","scheduler_finished_at","last_started_at","last_finished_at","leased_until"])
    if (r[key]!==null && typeof r[key]!=="string") return null;
  if (!r.last_result || typeof r.last_result!=="object") return null;
  const result: MatchingHealth["last_result"]={};
  for (const key of ["jobs","assigned","offered","needsScheduling","failed"] as const) {
    const n=(r.last_result as Record<string,unknown>)[key];
    if (n===null || n===undefined) continue;
    if (typeof n!=="number" || !Number.isInteger(n) || n<0) return null;
    result[key]=n;
  }
  return {
    observed_at:r.observed_at as string,state_present:r.state_present,
    scheduler_count:r.scheduler_count as number,scheduler_enabled:r.scheduler_enabled,expected_interval:r.expected_interval,
    scheduler_status:r.scheduler_status as string|null,scheduler_started_at:r.scheduler_started_at as string|null,scheduler_finished_at:r.scheduler_finished_at as string|null,
    last_status:r.last_status as MatchingHealth["last_status"],last_started_at:r.last_started_at as string|null,
    last_finished_at:r.last_finished_at as string|null,leased_until:r.leased_until as string|null,last_result:result,
  };
}
export function matchingHealthState(row: MatchingHealth | null, now: Date):
  "unavailable" | "not_configured" | "review_schedule" | "paused" | "waiting" | "running" | "healthy" | "failed" | "stale" {
  if (!row || !row.state_present || !Number.isFinite(now.getTime())) return "unavailable";
  const observed=time(row.observed_at);
  if (observed>now.getTime()+60000 || observed<now.getTime()-12*60000) return "unavailable";
  if (row.scheduler_count===0) return "not_configured";
  if (row.scheduler_count!==1 || !row.expected_interval) return "review_schedule";
  if (!row.scheduler_enabled) return "paused";
  if (row.scheduler_status==="failed" || row.last_status==="failed" || (row.last_result.failed??0)>0) return "failed";
  const started=time(row.last_started_at);
  if (row.last_status==="running") return Number.isFinite(started)&&started<=now.getTime()+60000&&time(row.leased_until)>now.getTime() ? "running" : "stale";
  if (["starting","connecting","sending","running"].includes(row.scheduler_status??"")) {
    const scheduledStart=time(row.scheduler_started_at);
    return Number.isFinite(scheduledStart)&&scheduledStart<=now.getTime()+60000&&scheduledStart>now.getTime()-3*60000 ? "running" : "stale";
  }
  if (!row.scheduler_status) return "waiting";
  if (row.scheduler_status!=="succeeded") return "unavailable";
  const finished=time(row.last_finished_at),scheduledStart=time(row.scheduler_started_at),scheduledEnd=time(row.scheduler_finished_at);
  if (row.last_status!=="success" || !Number.isFinite(finished) || !Number.isFinite(scheduledStart) || !Number.isFinite(scheduledEnd)
    || finished>now.getTime()+60000 || scheduledEnd>now.getTime()+60000 || finished<scheduledStart-30000
    || finished<now.getTime()-12*60000 || scheduledEnd<now.getTime()-12*60000) return "stale";
  if (row.last_result.failed!==0) return "unavailable";
  return "healthy";
}
