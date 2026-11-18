import Link from "next/link";
import { BUSINESS_TIME_ZONE } from "@/lib/time/zone";
import { formatCents } from "@/lib/money";
import { ASSIGNMENT_HISTORY_LIMIT, type AssignmentChange } from "@/lib/cleaners/assignment-history";
const historyTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
const time = (value: string) => historyTime.format(new Date(value));
export function AssignmentHistory({ changes, error, contractor }: { changes: AssignmentChange[]; error: string | null; contractor: boolean }) {
  return <section className="mt-8 border-t border-line pt-5" aria-labelledby="assignment-changes">
    <h2 id="assignment-changes" className="text-lg font-semibold text-navy">Changes to your assignments</h2>
    <p className="mt-2 max-w-prose text-sm text-ink-2">Your {ASSIGNMENT_HISTORY_LIMIT} latest assignment releases, in Dallas time. Includes older changes; schedule filters do not apply. Use your assigned visits above to see where to go.</p>
    {error ? <p role="alert" className="mt-4 text-sm">{error} <Link href="/cleaner/schedule" className="underline">Reload schedule</Link>.</p> : changes.length ? <ol className="mt-4 divide-y divide-line">{changes.map(change => <li key={change.key} className="py-4">
      <h3 className="font-semibold text-navy">{change.previousStart ? time(change.previousStart) : "Previous appointment time not recorded"}</h3>
      <p className="mt-1 text-sm">{change.kind === "crew" ? "Released after a crew change." : "Released after a schedule change."}</p>
      <p className="mt-1 text-sm text-ink-2">{change.newStart ? `Appointment changed to ${time(change.newStart)}. This record does not assign you to that time.` : "No replacement appointment time recorded."}</p>
      {contractor && <p className="mt-2 text-sm">Former agreed visit pay: {change.agreedCents !== null && change.agreedCents > 0 ? formatCents(change.agreedCents) : "Confirm with the office"}. This is not a payment record.</p>}
      <p className="mt-2 text-xs text-ink-2">Change recorded {time(change.releasedAt)}.</p>
    </li>)}</ol> : <p className="mt-4 text-sm text-ink-2">No assignment releases recorded for your account.</p>}
    <Link href="/cleaner/earnings" className="secondary-action mt-4 inline-flex">Review payment records</Link>
  </section>;
}
