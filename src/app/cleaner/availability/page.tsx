import Link from "next/link";
import { getRepository } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import type { AvailabilityWindow } from "@/lib/cleaners/availability-input";
import { AvailabilityForm } from "./availability-form";

export const metadata = { title: "My working hours | Hey Spotless" };
export const dynamic = "force-dynamic";

export default async function AvailabilityPage() {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  const cleaner = profile ? await repo.getCleanerByProfile(profile.id) : null;
  if (!repo.isDemo && (!profile || profile.role !== "cleaner" || !cleaner || cleaner.status !== "active")) return <section className="visit-feature">
    <h1 className="text-xl font-semibold text-navy">Your cleaner account</h1>
    <p className="mt-3">Sign in with your active cleaner account to manage working hours.</p>
    <Link href="/login?next=%2Fcleaner%2Favailability" className="secondary-action mt-4 inline-flex">Sign in</Link>
    <a href="tel:+14692800397" className="secondary-action mt-4 ml-3 inline-flex">Call the office</a>
  </section>;
  let windows: AvailabilityWindow[] = [];
  if (repo.isDemo) windows = [{ day: 1, startsAt: "09:00", endsAt: "15:00" }, { day: 3, startsAt: "09:00", endsAt: "15:00" }];
  else {
    const db = await createClient();
    const { data, error } = await db.from("cleaner_availability").select("day_of_week, starts_at, ends_at").eq("cleaner_id", cleaner!.id).order("day_of_week").order("starts_at");
    if (error) throw new Error("Unable to load your working hours.");
    windows = (data ?? []).map(row => ({ day: row.day_of_week, startsAt: String(row.starts_at).slice(0, 5), endsAt: String(row.ends_at).slice(0, 5) }));
  }
  return <>
    <p className="eyebrow">Your week</p><h1 className="mt-2 text-2xl font-semibold text-navy">My working hours</h1>
    <p className="mt-3 text-sm text-ink-2">Choose the weekly times you can take new visits, in Dallas time. Changes do not cancel or move visits you have already accepted.</p>
    <p className="mt-3 text-sm text-ink-2">Once you save hours, days with no window are unavailable for new matching. Each window must start and end on the same day. For time away from all work or changes to an accepted visit, <a href="tel:+14692800397" className="underline">call the office</a>.</p>
    <AvailabilityForm initialWindows={windows} demo={repo.isDemo} />
  </>;
}
