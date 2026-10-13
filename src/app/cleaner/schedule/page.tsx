import Link from "next/link";
import { getRepository } from "@/lib/data";
import type { VisitQuery } from "@/lib/experience/visit-filter";
import { VisitSections } from "@/components/visit-sections";

export const dynamic = "force-dynamic";
export const metadata = { title: "My schedule | Hey Spotless" };
export default async function SchedulePage({ searchParams }: { searchParams: Promise<VisitQuery> }) {
  const query = await searchParams;
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  const cleaner = profile ? await repo.getCleanerByProfile(profile.id) : repo.isDemo ? await repo.getCleanerByProfile("demo") : null;
  const jobs = cleaner ? await repo.listJobs({ cleanerId: cleaner.id }) : [];
  return <>
    <h1 className="welcome-title">My schedule</h1>
    <p className="mt-3 text-sm text-ink-2">Your assigned visits and history, in Dallas time. Open a visit for home notes and directions.</p>
    {!cleaner ? <section className="visit-feature mt-5"><h2 className="font-semibold text-navy">Let’s get you connected</h2><p className="mt-2 text-sm text-ink-2">Call the office to link your cleaner profile before jobs can appear.</p></section> : jobs.length === 0 ? <section className="visit-feature mt-5"><h2 className="font-semibold text-navy">No assigned visits yet</h2><p className="mt-2 text-sm text-ink-2"><Link href="/cleaner#offers" className="underline">Check available offers</Link>, or call the office if you expected a visit.</p></section> : <VisitSections jobs={jobs} area="cleaner" now={new Date()} query={query} />}
  </>;
}
