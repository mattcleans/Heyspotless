import { NextResponse } from "next/server";
import { getRepository } from "@/lib/data";
import { formatCents } from "@/lib/money";
import { formatDateTimeInZone } from "@/lib/time/zone";

/**
 * What the service worker asks when a push wakes it.
 *
 * The push itself carries nothing (see `lib/push/vapid.ts`), so this is where
 * the notification's words come from — and because it is fetched at the moment
 * the notification is shown, it says what is true NOW. A rung lives 8 to 15
 * minutes, and a notification about a job somebody else has already taken is
 * worse than no notification at all. `expired: true` is how the worker is told
 * to stay quiet.
 *
 * Read as the signed-in cleaner, under row-level security, like every other
 * page she sees. The service worker sends the session cookie for exactly this.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  if (!profile) return NextResponse.json({ expired: true });

  const cleaner = await repo.getCleanerByProfile(profile.id);
  if (!cleaner) return NextResponse.json({ expired: true });

  const offers = await repo.listLiveOffers(cleaner.id);
  const live = offers.filter((offer) => offer.expiresAt.getTime() > Date.now());

  // Nothing waiting: the offer was taken, withdrawn, or expired between the
  // push being queued and the phone waking up.
  if (live.length === 0) return NextResponse.json({ expired: true });

  // The one closest to running out. If several are waiting she is told about
  // the urgent one and the count, rather than being given a list she has to
  // read on a lock screen.
  const soonest = live.reduce((best, offer) =>
    offer.expiresAt < best.expiresAt ? offer : best,
  );

  const more = live.length > 1 ? ` · ${live.length - 1} more waiting` : "";

  return NextResponse.json({
    jobId: soonest.jobId,
    title: `${formatCents(soonest.payoutCents)} — ${soonest.city || "a clean"}`,
    body:
      `${soonest.scheduledStart ? formatDateTimeInZone(soonest.scheduledStart) : "Date to be confirmed"}` +
      `${more}`,
    url: "/cleaner",
  });
}
