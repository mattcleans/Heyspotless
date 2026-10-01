import Link from "next/link";
import { Avatar } from "@/components/cleaner-card";
import { VisitRefresh } from "@/components/visit-refresh";
import { Pill } from "@/components/ui";
import type { CleanerProfile } from "@/lib/cleaners/store";
import { firstName } from "@/lib/cleaners/profile";
import type { CustomerVisit } from "@/lib/visits/customer-visit-store";
import { finishEstimate } from "@/lib/visits/customer-visit";
import { STAGES, STAGE_LABELS, isStageReached, roomProgress, visitHeadline } from "@/lib/visits/progress";
import { formatDateTimeInZone } from "@/lib/time/zone";

export function CustomerVisitDetails({ id, details, cleaner, now = new Date() }: {
  id: string; details: CustomerVisit; cleaner: CleanerProfile | null; now?: Date;
}) {
  const visit = details.summary;
  const who = cleaner ? firstName(cleaner.fullName) : null;
  const progress = roomProgress(visit);
  const estimate = finishEstimate(visit, now);
  const canceled = visit.stage === "canceled";
  return <>
    <Link href="/customer/visits" className="mb-5 inline-flex min-h-11 items-center text-sm text-navy underline">Back to visits</Link>
    <p className="eyebrow">{STAGE_LABELS[visit.stage]}</p>
    <h1 className="mt-1 text-xl font-semibold tracking-tight text-navy">{visitHeadline(visit, who)}</h1>
    <p className="mt-2 text-sm text-ink-2">{details.address}</p>
    <dl className="mt-4 space-y-2 text-sm">
      <div><dt className="text-ink-3">{canceled ? "Original appointment" : "Appointment"}</dt><dd>{visit.scheduledStart ? formatDateTimeInZone(visit.scheduledStart) : "Time to be confirmed"}</dd></div>
      {!canceled && visit.startedAt && <div><dt className="text-ink-3">Started</dt><dd>{formatDateTimeInZone(visit.startedAt)}</dd></div>}
      {visit.stage === "done" && <div><dt className="text-ink-3">Finished</dt><dd>{visit.completedAt ? formatDateTimeInZone(visit.completedAt) : "Finish time not recorded"}</dd></div>}
    </dl>
    <p className="mt-2 text-xs text-ink-3">Times shown in Dallas time.</p>

    {canceled ? <section className="card mt-5 p-5">
      <h2 className="font-semibold text-navy">Need another appointment?</h2>
      <p className="mt-2 text-sm text-ink-2">This visit is canceled. Call the office to discuss a replacement, or request a new clean. A request needs confirmation before it becomes an appointment.</p>
      <Link href="/book" className="secondary-action mt-4 inline-flex">Request a clean</Link>
    </section> : <ol aria-label="Visit progress" className="mt-5 flex items-start gap-1.5">
      {STAGES.map(stage => <li key={stage} className="flex-1" aria-current={stage === visit.stage ? "step" : undefined}>
        <div className={`h-1.5 rounded-full ${isStageReached(stage, visit.stage) ? "bg-sky-deep" : "bg-line"}`} aria-hidden />
        <p className={`mt-1.5 text-xs leading-tight ${isStageReached(stage, visit.stage) ? "font-medium text-navy" : "text-ink-3"}`}>{STAGE_LABELS[stage]}</p>
      </li>)}
    </ol>}

    {estimate && <section className="card mt-4 p-4">
      <h2 className="text-sm font-semibold text-navy">Estimated finish</h2>
      <p className="mt-1 text-sm">{formatDateTimeInZone(visit.expectedFinishAt!)}</p>
      <p className="mt-2 text-sm text-ink-2">{estimate === "passed" ? "The estimated finish time has passed. The visit is still marked in progress; this does not confirm your cleaner has finished. Refresh for the latest update or call the office." : "This estimate uses the recorded start and planned clean time. It can change as work continues."}</p>
    </section>}

    {!canceled && (cleaner ? <Link href={`/customer/cleaners/${cleaner.id}`} className="card mt-5 flex min-h-11 items-center gap-3 p-4 transition-colors hover:border-sky-deep">
      <Avatar cleaner={cleaner} />
      <div className="min-w-0 flex-1"><p className="font-medium text-navy">{who}</p><p className="text-xs text-ink-3">Cleaner for this visit · view profile</p></div>
      {cleaner.backgroundCheckCleared && <Pill tone="good">Vetted</Pill>}
    </Link> : <p className="card mt-5 p-4 text-sm text-ink-2">{visit.stage === "scheduled" ? "We’ll confirm your cleaner here once matched." : "Cleaner profile details are unavailable. Call the office if you need to confirm who is attending."}</p>)}

    {(visit.stage === "cleaning" || visit.stage === "done") && <section className="card mt-4 p-5">
      <h2 className="font-semibold text-navy">Room photo updates</h2>
      {progress === null ? <p className="mt-2 text-sm text-ink-2">Room progress is unavailable because this home has no configured rooms. Call the office to check the home details.</p> : <>
        <p className="nums mt-2 text-sm text-navy">{visit.roomsDone} of {visit.roomsTotal} rooms have before-and-after photos recorded.</p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden><div className="h-full rounded-full bg-sky-deep" style={{width:`${Math.round(progress * 100)}%`}} /></div>
        <p className="mt-3 text-xs text-ink-3">{visit.stage === "done" ? "The visit is marked finished. Photos may still be waiting to upload from the cleaner’s phone." : "Photos can upload later when the cleaner reconnects. Missing photos do not tell us that a room is unfinished."}</p>
        <ul className="mt-3 divide-y divide-line">{details.rooms.map(room => <li key={room.key} className="flex flex-wrap justify-between gap-2 py-2 text-sm"><span>{room.label}</span><span className={room.recorded ? "text-navy" : "text-ink-3"}>{room.recorded ? "Photos recorded" : "Awaiting photo updates"}</span></li>)}</ul>
      </>}
    </section>}
    {!canceled && <VisitRefresh />}
    {!canceled && visit.stage !== "done" && <Link href={`/customer/account/homes/${details.propertyId}`} className="mt-4 inline-flex min-h-11 items-center text-sm text-navy underline">Review home instructions</Link>}
    <p className="mt-5 text-sm text-ink-2">Need help with this visit? <a href="tel:+14692800397" className="inline-flex min-h-11 items-center text-navy underline">Call Hey Spotless</a>.</p>
    {visit.stage === "done" && <Link href={`/customer/visits/${id}/rate`} className="mt-5 block min-h-11 w-full rounded-lg bg-navy px-4 py-3 text-center text-sm font-semibold text-white">Rate this clean</Link>}
  </>;
}
