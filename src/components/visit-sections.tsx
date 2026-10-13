import type { Job } from "@/lib/data/types";
import { visitSections } from "@/lib/experience/schedule";
import { VisitList } from "./visit-list";
import Link from "next/link";
import { filterVisits, VISIT_VIEWS, type VisitQuery } from "@/lib/experience/visit-filter";

export function VisitSections({ jobs, area, now, query = {} }: { jobs: readonly Job[]; area: "customer" | "cleaner" | "admin"; now: Date; query?: VisitQuery }) {
  const filtered = filterVisits(jobs, query, now);
  const sections = visitSections(filtered.jobs, now);
  const path = area === "customer" ? "/customer/visits" : `/${area}/schedule`;
  const groups = [
    { title: "Cleaning now", jobs: sections.ongoing },
    { title: "Upcoming visits", jobs: sections.upcoming },
    { title: "Time to be confirmed", jobs: sections.awaitingTime },
    { title: "Past visits needing an update", jobs: sections.unresolved },
    { title: "Visit history", jobs: sections.history },
  ];
  return <>
    <form action={path} method="get" role="search" aria-label="Find visits" className="visit-feature mt-5 grid gap-4 sm:grid-cols-2">
      <label className="block text-sm text-ink-2">Search visits<input name="q" type="search" defaultValue={filtered.q} maxLength={120} placeholder="Name, address, city, or service" className="mt-1 min-h-11 w-full rounded-lg border border-line bg-white px-3 text-base" /></label>
      <label className="block text-sm text-ink-2">Show<select name="view" defaultValue={filtered.view} className="mt-1 min-h-11 w-full rounded-lg border border-line bg-white px-3 text-base">{Object.entries(VISIT_VIEWS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="block text-sm text-ink-2">Appointment date (Dallas time)<input name="day" type="date" defaultValue={filtered.day} className="mt-1 min-h-11 w-full rounded-lg border border-line bg-white px-3 text-base" /></label>
      <div className="flex flex-wrap items-end gap-3"><button type="submit" className="primary-action">Find visits</button><Link href={path} className="secondary-action">Clear filters</Link></div>
    </form>
    <p className="mt-4 text-sm text-ink-2" role="status">{filtered.jobs.length} {filtered.jobs.length === 1 ? "visit" : "visits"} shown</p>
    {filtered.jobs.length === 0 && <section className="visit-feature mt-4"><h2 className="font-semibold text-navy">No visits match these filters</h2><p className="mt-2 text-sm text-ink-2">Try another name or date, or clear the filters to see your recorded visits.</p></section>}
    {groups.filter((group) => group.jobs.length > 0).map((group) => <section key={group.title} className="mt-7">
    <div className="section-heading"><h2>{group.title}</h2><span className="text-sm text-ink-2">{group.jobs.length}</span></div>
    {group.jobs === sections.unresolved && <p className="mb-3 text-sm text-ink-2">These visits have a past appointment time and no completion recorded. {area === "admin" ? "Open the customer record to review completion or scheduling." : "Contact the office if the details need correcting."}</p>}
    <VisitList jobs={group.jobs} area={area} />
  </section>)}</>;
}
