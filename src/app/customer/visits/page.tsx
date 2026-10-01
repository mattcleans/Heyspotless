import Link from "next/link";
import { getRepository } from "@/lib/data";
import type { VisitQuery } from "@/lib/experience/visit-filter";
import { VisitSections } from "@/components/visit-sections";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your visits | Hey Spotless" };

export default async function VisitsPage({ searchParams }: { searchParams: Promise<VisitQuery> }) {
  const query = await searchParams;
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();
  const customer = profile
    ? await repo.getCustomerByProfile(profile.id)
    : repo.isDemo ? await repo.getCustomerByProfile("demo") : null;
  const jobs = customer ? await repo.listJobs({ customerId: customer.id }) : [];
  return <>
    <div className="flex flex-wrap items-center justify-between gap-4">
      <h1 className="welcome-title">Your visits</h1>
      <Link href="/book" className="primary-action">Request a clean</Link>
    </div>
    <p className="mt-3 text-sm text-ink-2">Visit times are shown in Dallas time. Open a visit for its latest details.</p>
    {!customer && !repo.isDemo ? <section className="visit-feature mt-5">
      <h2 className="font-semibold text-navy">Let’s connect your account</h2>
      <p className="mt-2 text-sm text-ink-2">Your account isn’t linked to a client profile yet. <a href="tel:+14692800397" className="underline">Call the office</a> to connect your existing visits.</p>
    </section> : jobs.length === 0 ? <section className="visit-feature mt-5">
      <h2 className="font-semibold text-navy">Your next clean starts here</h2>
      <p className="mt-2 text-sm text-ink-2">Request a clean above. We’ll confirm the time and cleaner with you.</p>
    </section> : <VisitSections jobs={jobs} area="customer" now={new Date()} query={query} />}
  </>;
}
