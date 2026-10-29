import { formatVisitRoomCounts, type VisitRoomScope } from "@/lib/service/visit-room-scope";
import { formatDateTimeInZone } from "@/lib/time/zone";

export function VisitRoomScopeNote({ scope, office = false, showCounts = false }: { scope?: VisitRoomScope | null; office?: boolean; showCounts?: boolean }) {
  if (!scope) return <p className="mt-3 text-sm text-ink-2">The saved room list needs office review. Home details cannot replace this visit’s room list.</p>;
  return <>
    {showCounts && <p className="mt-3 max-w-2xl text-sm leading-relaxed text-navy">{formatVisitRoomCounts(scope.rooms)}.</p>}
    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-2">
    {scope.source === "legacy_home"
      ? office ? `Room list saved from home details during setup on ${formatDateTimeInZone(scope.capturedAt)}. Original booked counts were unavailable; compare the booking terms before issuing the invoice.` : "This visit’s room list was saved from the home details on file. Contact the office if it needs a correction."
      : scope.source === "client_booking" || scope.source === "client_quote" ? "This room list comes from the confirmed booking terms." : scope.source === "plan_created" ? "This room list was saved for your recurring schedule." : "This room list was saved when the visit was created."}
    {" "}Later home updates do not change this visit’s checklist.
    </p>
  </>;
}
