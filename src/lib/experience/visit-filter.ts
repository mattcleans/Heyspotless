import type { Job } from "@/lib/data/types";
import { SERVICE_LABELS } from "@/lib/pricing/price-book";
import { todayIn, toCalendarDate } from "@/lib/time/zone";
import { JOB_LABELS, visitSections } from "./schedule";

export type VisitQuery = { q?: string | string[]; day?: string | string[]; view?: string | string[] };
export const VISIT_VIEWS = {
  all: "All visits",
  ongoing: "Cleaning now",
  upcoming: "Upcoming visits",
  awaitingTime: "Time to be confirmed",
  unresolved: "Past visits needing an update",
  history: "Visit history",
} as const;

export function filterVisits(jobs: readonly Job[], query: VisitQuery, now: Date) {
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 120) : "";
  const day = toCalendarDate(query.day);
  const view = typeof query.view === "string" && Object.hasOwn(VISIT_VIEWS, query.view)
    ? query.view as keyof typeof VISIT_VIEWS : "all";
  const candidates = view === "all" ? jobs : visitSections(jobs, now)[view];
  const terms = q.toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean);
  const filtered = candidates.filter((job) => {
    if (day && (!job.scheduledStart || todayIn(undefined, job.scheduledStart) !== day)) return false;
    const text = [job.customerName, job.street, job.city, SERVICE_LABELS[job.service], JOB_LABELS[job.status]].join(" ").toLocaleLowerCase("en-US");
    return terms.every((term) => text.includes(term));
  });
  return { jobs: filtered, q, day: day ?? "", view };
}
