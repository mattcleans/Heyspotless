import Link from "next/link";
import { getRepository } from "@/lib/data";
import type { VisitQuery } from "@/lib/experience/visit-filter";
import { VisitSections } from "@/components/visit-sections";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedule | Hey Spotless management" };
export default async function SchedulePage({ searchParams }: { searchParams: Promise<VisitQuery> }) {
  const query = await searchParams;
  const repo = await getRepository();
  const jobs = await repo.listJobs();
  return <>
    <div className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-3xl font-semibold tracking-tight text-navy">Visit schedule</h1><Link href="/admin/customers" className="primary-action">Book a customer</Link></div>
    <p className="mt-3 text-sm text-ink-2">See upcoming visits, missing times, unresolved appointments, and history. Times are shown in Dallas time.</p>
    {jobs.length === 0 ? <p className="visit-feature mt-5">No visits recorded yet. Open Customers to arrange the first visit.</p> : <VisitSections jobs={jobs} area="admin" now={new Date()} query={query} />}
  </>;
}
