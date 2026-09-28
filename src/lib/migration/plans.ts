import type { Frequency, ServiceType } from "../pricing/price-book";
import { mapFrequency, mapService, parseFlag, parseMoneyCents, type MappedJob } from "./hcp.ts";
import { pick } from "./csv.ts";
import { calendarDaysBetween, toCalendarDate, type CalendarDate } from "../time/zone.ts";

/**
 * Recurring plans, from an export that does not have any.
 *
 * Housecall Pro exports a `Recurring` flag on each job and nothing else — no
 * frequency, no plan, no agreed price. Without plans, `recurring_price_audit`
 * is empty, and that audit is the reason the import exists. So a plan is
 * reconstructed, in this order:
 *
 *   1. A person said so. The `--plans` file Matt and Maddie fill in always wins.
 *   2. The dates say so. At least three recurring visits to one property, whose
 *      median spacing lands clearly in a weekly, fortnightly or monthly band.
 *   3. Neither. No plan, and the customer is listed as needing a person.
 *
 * The bands have gaps between them on purpose. A median of ten or eleven days
 * is not "roughly weekly" or "roughly fortnightly"; it is a customer whose
 * schedule a person should look at, and a plan at the wrong frequency is a
 * customer billed wrongly every visit for ever.
 *
 * NEVER FROM A NON-RECURRING JOB. A customer who books a one-off clean every
 * month by phone has not agreed a monthly rate, and inventing a plan would put
 * them in an audit of prices they never agreed.
 */

export interface PlanJob {
  job: MappedJob;
  customerHcpId: string;
  propertyKey: string;
}

export interface PlanOverride {
  /** 1-based data row, for the report. */
  row: number;
  customerContact: string;
  street: string | null;
  freq: Frequency;
  service: ServiceType | null;
  agreedPriceCents: number | null;
  anchorDate: CalendarDate | null;
  active: boolean | null;
}

export interface PlannedPlan {
  hcpPlanId: string;
  customerHcpId: string;
  propertyKey: string;
  freq: Frequency;
  service: ServiceType;
  agreedPriceCents: number;
  anchorDate: CalendarDate;
  active: boolean;
  source: "override" | "inferred";
  jobCount: number;
  medianGapDays: number | null;
  /** The imported jobs this plan covers, which take its frequency. */
  jobHcpIds: string[];
}

export interface PlanGap {
  customerHcpId: string;
  propertyKey: string;
  jobCount: number;
  medianGapDays: number | null;
  reason: "needs frequency" | "no price" | "no anchor date";
}

/** Consecutive visits the median is taken over — recent enough to be the current cadence. */
export const RECENT_VISITS = 6;
export const MIN_VISITS = 3;

/**
 * Which cadence a median gap is, or null for one a person should look at.
 * Inclusive at both ends of each band.
 */
export function frequencyFromGap(days: number): Frequency | null {
  if (days >= 5 && days <= 9) return "weekly";
  if (days >= 12 && days <= 16) return "biweekly";
  if (days >= 26 && days <= 35) return "monthly";
  return null;
}

/**
 * The median gap, in days, between the most recent `RECENT_VISITS` dates.
 * Null with fewer than `MIN_VISITS` dates — two visits are a coincidence.
 */
export function medianGapDays(dates: readonly CalendarDate[]): number | null {
  const sorted = [...dates].sort();
  if (sorted.length < MIN_VISITS) return null;
  const recent = sorted.slice(-RECENT_VISITS);
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) gaps.push(calendarDaysBetween(recent[i - 1]!, recent[i]!));
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
}

/**
 * The overrides file: `customer_email_or_phone, street, freq, service,
 * agreed_price, anchor_date, active`. Only the customer and `freq` are
 * required; a blank anything-else is filled from the jobs, exactly as an
 * inferred plan would be.
 */
export function parsePlanOverrides(
  records: readonly Record<string, string>[],
): { overrides: PlanOverride[]; problems: { row: number; reason: string; raw: string }[] } {
  const overrides: PlanOverride[] = [];
  const problems: { row: number; reason: string; raw: string }[] = [];

  records.forEach((record, i) => {
    const row = i + 1;
    const contact = pick(record, "customer_email_or_phone");
    if (!contact) {
      problems.push({ row, reason: "plan override: no customer_email_or_phone", raw: "" });
      return;
    }

    const freqRaw = pick(record, "freq");
    const freq = mapFrequency(freqRaw);
    if (!freq || freq === "one_time") {
      problems.push({ row, reason: "plan override: freq must be weekly, biweekly or monthly", raw: freqRaw ?? "" });
      return;
    }

    const serviceRaw = pick(record, "service");
    const service = serviceRaw ? mapService(serviceRaw) : null;
    if (serviceRaw && !service) {
      problems.push({ row, reason: "plan override: unrecognised service", raw: serviceRaw });
      return;
    }

    const priceRaw = pick(record, "agreed_price");
    const price = priceRaw ? parseMoneyCents(priceRaw) : null;
    if (priceRaw && (price === null || price <= 0)) {
      problems.push({ row, reason: "plan override: unreadable agreed_price", raw: priceRaw });
      return;
    }

    const anchorRaw = pick(record, "anchor_date");
    const anchor = anchorRaw ? toCalendarDate(anchorRaw) : null;
    if (anchorRaw && !anchor) {
      problems.push({ row, reason: "plan override: anchor_date must be YYYY-MM-DD", raw: anchorRaw });
      return;
    }

    const activeRaw = pick(record, "active");

    overrides.push({
      row,
      customerContact: contact,
      street: pick(record, "street"),
      freq,
      service,
      agreedPriceCents: price,
      anchorDate: anchor,
      active: activeRaw === null ? null : parseFlag(activeRaw),
    });
  });

  return { overrides, problems };
}

function byDate(a: PlanJob, b: PlanJob): number {
  const x = a.job.scheduledDate ?? "";
  const y = b.job.scheduledDate ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Every plan the import will write, and every recurring customer it could not
 * write one for.
 *
 * `overrides` is keyed by property key, already resolved to a customer and a
 * property by the caller.
 */
export function buildPlans(
  jobs: readonly PlanJob[],
  overrides: ReadonlyMap<string, PlanOverride & { customerHcpId: string }>,
  today: CalendarDate,
): { plans: PlannedPlan[]; gaps: PlanGap[] } {
  const groups = new Map<string, PlanJob[]>();
  for (const entry of jobs) {
    if (!entry.job.recurring || entry.job.status === "canceled") continue;
    const list = groups.get(entry.propertyKey) ?? [];
    list.push(entry);
    groups.set(entry.propertyKey, list);
  }

  const plans: PlannedPlan[] = [];
  const gaps: PlanGap[] = [];
  const keys = new Set([...groups.keys(), ...overrides.keys()]);

  for (const propertyKey of [...keys].sort()) {
    const group = (groups.get(propertyKey) ?? []).slice().sort(byDate);
    const override = overrides.get(propertyKey);
    const customerHcpId = override?.customerHcpId ?? group[0]!.customerHcpId;

    const dates = group.flatMap((g) => (g.job.scheduledDate ? [g.job.scheduledDate] : []));
    const gap = medianGapDays(dates);
    const freq = override?.freq ?? (gap === null ? null : frequencyFromGap(gap));
    const base = { customerHcpId, propertyKey, jobCount: group.length, medianGapDays: gap };

    if (!freq) {
      gaps.push({ ...base, reason: "needs frequency" });
      continue;
    }

    const latestPriced = group.filter((g) => g.job.priceCents > 0).at(-1);
    const price = override?.agreedPriceCents ?? latestPriced?.job.priceCents ?? null;
    if (!price) {
      gaps.push({ ...base, reason: "no price" });
      continue;
    }

    const upcoming = group.find(
      (g) => g.job.status === "scheduled" && g.job.scheduledDate !== null && g.job.scheduledDate >= today,
    );
    const lastCompleted = group.filter((g) => g.job.status === "complete" && g.job.scheduledDate).at(-1);
    const anchor = override?.anchorDate ?? upcoming?.job.scheduledDate ?? lastCompleted?.job.scheduledDate ?? null;
    if (!anchor) {
      gaps.push({ ...base, reason: "no anchor date" });
      continue;
    }

    plans.push({
      ...base,
      hcpPlanId: `${propertyKey}:${freq}`,
      freq,
      service: override?.service ?? group.at(-1)?.job.service ?? "standard",
      agreedPriceCents: price,
      anchorDate: anchor,
      active: override?.active ?? upcoming !== undefined,
      source: override ? "override" : "inferred",
      jobHcpIds: group.map((g) => g.job.hcpId),
    });
  }

  return { plans, gaps };
}
