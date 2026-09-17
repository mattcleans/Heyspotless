/**
 * Reading the lead book.
 *
 * Pure: the arithmetic on a list of leads, with no idea where the list came
 * from. Time-to-first-response is the KPI the whole phase is measured on, and a
 * KPI computed inside a React component is one nobody can test.
 */

export interface LeadRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  rawAddress: string | null;
  zip: string | null;
  status: string;
  source: string;
  service: string | null;
  frequency: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  quotedPriceCents: number | null;
  receivedAt: Date;
  firstResponseAt: Date | null;
  smsConsentAt: Date | null;
  attribution: Record<string, unknown> | null;
}

export interface ResponseStats {
  answered: number;
  waiting: number;
  /** Median, not mean: one lead answered three days late drags a mean into fiction. */
  medianMinutes: number | null;
  /** The lead that has been waiting longest, in minutes. The thing to do next. */
  longestWaitingMinutes: number | null;
  /** Won over everything that reached a decision. Leads still open are excluded. */
  conversionRate: number | null;
}

export function responseMinutes(lead: LeadRow): number | null {
  if (!lead.firstResponseAt) return null;
  return Math.max(0, (lead.firstResponseAt.getTime() - lead.receivedAt.getTime()) / 60_000);
}

export function waitingMinutes(lead: LeadRow, now: Date): number | null {
  if (lead.firstResponseAt) return null;
  if (lead.status !== "new" && lead.status !== "quoted") return null;
  return Math.max(0, (now.getTime() - lead.receivedAt.getTime()) / 60_000);
}

/**
 * The four numbers worth putting at the top of the screen.
 *
 * `conversionRate` deliberately excludes leads that have not been decided yet.
 * Counting open leads as losses makes this morning's enquiries look like
 * failures and makes the number meaningless on any day the business is busy.
 */
export function responseStats(leads: readonly LeadRow[], now: Date): ResponseStats {
  const answeredTimes = leads
    .map(responseMinutes)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);

  const waits = leads
    .map((lead) => waitingMinutes(lead, now))
    .filter((m): m is number => m !== null);

  const decided = leads.filter((l) => l.status === "won" || l.status === "lost");
  const won = decided.filter((l) => l.status === "won").length;

  return {
    answered: answeredTimes.length,
    waiting: waits.length,
    medianMinutes: median(answeredTimes),
    longestWaitingMinutes: waits.length > 0 ? Math.max(...waits) : null,
    conversionRate: decided.length > 0 ? won / decided.length : null,
  };
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/** "4m", "2h 10m", "3d" — a duration somebody reads at a glance. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 60 * 24) {
    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes % 60);
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${Math.round(minutes / (60 * 24))}d`;
}

/**
 * How urgent an unanswered lead is.
 *
 * The thresholds are the ones the build plan's argument rests on rather than
 * round numbers: inside an hour is the target, past four hours the odds fall
 * off a cliff, and past a day it is somebody else's customer.
 */
export function urgencyOf(minutes: number | null): "fresh" | "slipping" | "cold" | null {
  if (minutes === null) return null;
  if (minutes <= 60) return "fresh";
  if (minutes <= 60 * 4) return "slipping";
  return "cold";
}
