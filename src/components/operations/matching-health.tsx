import Link from "next/link";
import {formatDateTimeInZone} from "@/lib/time/zone";
import {matchingHealthState,type MatchingHealth} from "@/lib/operations/matching-health";
const copy={
 healthy:["Running on schedule","Automatic matching retry is active. Review visits that still need a person."],
 running:["Matching is in progress","The current attempt has not finished. Saved pending visits remain available."],
 waiting:["Waiting for the first scheduled run","Automatic retry is enabled, but a completed scheduled run is not yet recorded."],
 not_configured:["Automatic retry is not configured","Review pending visits while automatic follow-through is set up."],
 review_schedule:["The matching schedule needs review","The saved retry schedule is not the expected single five-minute schedule. Review pending visits while it is checked."],
 paused:["Automatic retry is paused","Review pending visits while automatic follow-through is restored."],
 failed:["Matching needs attention","The latest recorded attempt failed or reported unfinished work. Pending visits remain saved for retry."],
 stale:["A recent matching result is missing","The last run is overdue or unfinished. Review pending visits while follow-through is checked."],
 unavailable:["Matching status is unavailable","Reload this page before relying on automatic follow-through."],
} as const;
export function MatchingHealthSection({health,now}:{health:MatchingHealth|null;now:Date}) {
 const state=matchingHealthState(health,now),[title,description]=copy[state];
 const finished=health?.last_finished_at?new Date(health.last_finished_at):null;
 return <section aria-labelledby="matching-health-title" className="mt-6 rounded-2xl bg-surface-2 p-5 sm:p-6">
  <div className="flex flex-wrap items-start justify-between gap-5">
   <div className="max-w-2xl">
    <h2 id="matching-health-title" className="text-lg font-semibold text-navy">Automatic matching</h2>
    <p className={`mt-3 text-lg font-semibold ${state==="healthy"?"text-good":["failed","stale","review_schedule"].includes(state)?"text-bad":"text-navy"}`}>{title}</p>
    <p className="mt-2 text-sm leading-relaxed text-ink-2">{description}</p>
    {health&&finished&&Number.isFinite(finished.getTime())&&<>
     <p className="mt-3 text-sm text-ink-2">Last finished attempt: {formatDateTimeInZone(finished)}. Dallas time.</p>
     {[health.last_result.assigned,health.last_result.offered,health.last_result.needsScheduling].every(n=>typeof n==="number")
      ? <p className="mt-1 text-sm text-ink-2">Saved result: {health.last_result.assigned} assignments, {health.last_result.offered} offers and {health.last_result.needsScheduling} appointments needing review. This does not confirm delivery or completed cleans.</p>
      : <p className="mt-1 text-sm text-ink-2">Detailed result counts are unavailable for this attempt.</p>}
    </>}
   </div>
   <div className="flex flex-wrap gap-3">
    <Link href="/admin/dispatch" className="secondary-action">Review matching exceptions</Link>
    <a href="/admin/automation" className="secondary-action">Reload status</a>
   </div>
  </div>
 </section>;
}
