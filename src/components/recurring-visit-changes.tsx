import Link from "next/link";
import type { RecurringVisitChange } from "@/lib/customer/recurring/store";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { formatCents } from "@/lib/money";
export function RecurringVisitChanges({
  changes,
  office = false,
}: {
  changes: RecurringVisitChange[];
  office?: boolean;
}) {
  if (changes.length === 0) return null;
  return (
    <section className="visit-feature mt-5">
      <h2 className="font-semibold text-navy">Recurring schedule history</h2>
      <p className="mt-2 text-xs text-ink-2">
        Latest three saved pattern changes for this visit. The appointment above
        shows its current state.
      </p>
      <ol className="mt-3 divide-y divide-line">
        {changes.map((c) => (
          <li className="py-3 text-sm" key={c.id}>
            <p className="font-semibold">
              {
                {
                  moved: "Moved with the recurring schedule",
                  removed: "Removed from the recurring schedule",
                  added: "Added to the recurring schedule",
                  kept: "Kept when the recurring schedule changed",
                }[c.action]
              }
            </p>
            {c.action === "removed" ? (
              <p className="mt-1">
                This future visit was canceled without a cancellation fee.
              </p>
            ) : (
              <p className="mt-1">
                {c.newStart
                  ? formatDateTimeInZone(new Date(c.newStart))
                  : "Time to be confirmed"}
                {c.priceCents !== null ? ` · ${formatCents(c.priceCents)}` : ""}
              </p>
            )}
            <p className="mt-1 text-xs text-ink-2">
              {c.reason} · Saved {formatDateTimeInZone(new Date(c.savedAt))}
            </p>
            <Link
              className="mt-2 inline-flex min-h-11 items-center underline"
              href={`/${office ? "admin" : "customer"}/schedules/${c.planId}`}
            >
              View recurring schedule
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
