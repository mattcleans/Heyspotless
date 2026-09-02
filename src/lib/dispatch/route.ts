/**
 * Route density.
 *
 * Because Shonda's 2.5 hours is cleaning only and her travel between jobs is
 * paid, every mile between houses bills at $17.50 — or $26.25 once she is past
 * forty hours. Tightening her average drive from 30 minutes to 15 saves about
 * $5,887 a year, more than twice what cancelling Housecall Pro saves, from
 * nothing but scheduling her days as geographic clusters instead of
 * chronological lists.
 *
 * So clustering is a first-class part of dispatch, not a nicety: when the
 * engine picks which of her open slots a job lands in, it minimizes drive, and
 * it declines to scatter her across the metroplex to satisfy a mild time
 * preference.
 */

import type { Cleaner, DispatchJob, DriveLeg } from "./types";
import { wageCents } from "./marginal-cost";

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** Pluggable so a real routing API can replace the estimate without changing callers. */
export type DriveEstimator = (fromZip: string | undefined, toZip: string) => DriveLeg;

/** Great-circle distance in miles. */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * DFW surface streets average roughly 28 mph door to door once you account for
 * lights and residential approach, and real road distance runs about 1.25x the
 * straight line. Both are replaced by a routing API in production.
 */
export const AVERAGE_MPH = 28;
export const ROAD_WINDING_FACTOR = 1.25;

export function driveFromPoints(a: GeoPoint, b: GeoPoint): DriveLeg {
  const miles = haversineMiles(a, b) * ROAD_WINDING_FACTOR;
  return { miles: round2(miles), minutes: Math.round((miles / AVERAGE_MPH) * 60) };
}

/** Build an estimator from a ZIP centroid table. */
export function zipCentroidEstimator(
  centroids: Readonly<Record<string, GeoPoint>>,
  fallback: DriveLeg = { minutes: 20, miles: 12 },
): DriveEstimator {
  return (fromZip, toZip) => {
    if (!fromZip) return { minutes: 0, miles: 0 }; // first job of the day
    const from = centroids[fromZip];
    const to = centroids[toZip];
    if (!from || !to) return fallback;
    return driveFromPoints(from, to);
  };
}

/** A fixed-drive estimator, for modeling and tests. */
export function constantEstimator(minutes: number, miles: number): DriveEstimator {
  return (fromZip) => (fromZip ? { minutes, miles } : { minutes: 0, miles: 0 });
}

// ---------------------------------------------------------------- clustering

export interface SlotCandidate {
  job: DispatchJob;
  /** Where the cleaner would be coming from if this job took this slot. */
  previousZip?: string;
}

/**
 * Order a day's jobs to minimize total drive, starting from where the cleaner
 * begins. Nearest-neighbour: for a single cleaner's day (rarely more than six
 * or seven stops) this is within a few percent of optimal and is instant.
 */
export function clusterDay<T extends DispatchJob>(
  jobs: readonly T[],
  startZip: string | undefined,
  estimate: DriveEstimator,
): { ordered: T[]; totalDriveMinutes: number; totalMiles: number } {
  const remaining = [...jobs];
  const ordered: T[] = [];
  let cursor = startZip;
  let totalDriveMinutes = 0;
  let totalMiles = 0;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestLeg = estimate(cursor, remaining[0]!.zip);

    for (let i = 1; i < remaining.length; i++) {
      const leg = estimate(cursor, remaining[i]!.zip);
      if (leg.minutes < bestLeg.minutes) {
        bestIndex = i;
        bestLeg = leg;
      }
    }

    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next!);
    totalDriveMinutes += bestLeg.minutes;
    totalMiles += bestLeg.miles;
    cursor = next!.zip;
  }

  return { ordered, totalDriveMinutes, totalMiles: round2(totalMiles) };
}

// ------------------------------------------------------- overtime forecast

export interface WeekForecast {
  cleanMinutes: number;
  driveMinutes: number;
  totalHours: number;
  overtimeHours: number;
  /** Fully burdened cost of the week, guaranteed hours included. */
  weeklyCostCents: number;
  costPerJobCents: number;
  /** Share of a ticket this cleaner's time consumes, at the given average price. */
  shareOfTicket: number;
}

/**
 * Forecast a cleaner's week BEFORE it is committed.
 *
 * The plan is blunt about why this exists: 15 jobs at 2.5 hours is 37.5 hours
 * of cleaning, which leaves 2.5 of the guaranteed 40 for every mile driven —
 * ten minutes a job, which is not real in DFW. Fifteen jobs a week is a 43-45
 * hour schedule with 3-5 hours of overtime in it. That is still the cheapest
 * labor available, but the schedule should be built knowing it, and the app
 * should show the overtime before the week is committed rather than after
 * payroll.
 */
export function forecastWeek(
  cleaner: Cleaner,
  jobs: readonly { cleanMinutes: number; driveMinutes: number }[],
  averageTicketCents: number,
  /**
   * Minutes already on this cleaner's schedule before `jobs`. Counted toward
   * hours and overtime but not toward the per-job cost, so planning three more
   * jobs onto a part-full week reports the right overtime without pretending
   * the earlier work was free.
   */
  priorMinutes = 0,
): WeekForecast {
  const cleanMinutes = priorMinutes + jobs.reduce((a, j) => a + j.cleanMinutes, 0);
  const driveMinutes = cleaner.terms?.driveTimePaid
    ? jobs.reduce((a, j) => a + j.driveMinutes, 0)
    : 0;

  const totalMinutes = cleanMinutes + driveMinutes;
  const terms = cleaner.terms;
  const otThresholdMinutes = Math.round((terms?.overtimeThresholdHours ?? 40) * 60);
  const guaranteedMinutes = Math.round((terms?.guaranteedHoursPerWeek ?? 0) * 60);
  const overtimeMinutes = Math.max(0, totalMinutes - otThresholdMinutes);

  // Guaranteed hours are paid whether or not they are worked, so a light week
  // still costs the full guarantee. That is the whole point of spending them
  // first, and it is what the idle-hours alert is measuring.
  const regularMinutes = Math.max(guaranteedMinutes, Math.min(totalMinutes, otThresholdMinutes));

  const weeklyCostCents = terms
    ? wageCents(
        regularMinutes,
        overtimeMinutes,
        terms.hourlyRateCents,
        terms.overtimeMultiplier,
        terms.employerBurdenRate,
      )
    : 0;

  const costPerJobCents = jobs.length > 0 ? Math.round(weeklyCostCents / jobs.length) : 0;

  return {
    cleanMinutes,
    driveMinutes,
    totalHours: round2(totalMinutes / 60),
    overtimeHours: round2(overtimeMinutes / 60),
    weeklyCostCents,
    costPerJobCents,
    shareOfTicket: averageTicketCents > 0 ? costPerJobCents / averageTicketCents : 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
