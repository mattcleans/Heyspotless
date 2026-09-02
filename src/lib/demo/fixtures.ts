/**
 * Demo-mode data.
 *
 * DEMO_MODE lets the whole admin UI run with no Supabase project, no keys, and
 * no network — which is how this app is reviewable before any of the phase-00
 * checklist exists. Every figure here is representative, not real customer
 * data. The cleaners use the actual W-2 terms from the build plan.
 */

import { buildQuote } from "../pricing/quote";
import { contractor, iggy, shonda } from "../dispatch/fixtures";
import type { Cleaner, DispatchJob } from "../dispatch/types";
import type { Frequency, ServiceType } from "../pricing/price-book";

export interface DemoJob extends DispatchJob {
  customerName: string;
  street: string;
  city: string;
  service: ServiceType;
  frequency: Frequency;
  bedrooms: number;
  bathrooms: number;
}

/** Fixed "now" so the demo board is stable across reloads. */
export const DEMO_NOW = new Date("2026-09-01T14:00:00Z");

function make(
  id: string,
  customerName: string,
  street: string,
  city: string,
  zip: string,
  service: ServiceType,
  frequency: Frequency,
  bedrooms: number,
  bathrooms: number,
  hoursFromNow: number | null,
): DemoJob {
  const quote = buildQuote(service, frequency, { bedrooms, bathrooms });
  return {
    id,
    customerName,
    street,
    city,
    zip,
    service,
    frequency,
    bedrooms,
    bathrooms,
    priceCents: quote.totalCents,
    estimatedCleanMinutes: quote.estimatedMinutes,
    scheduledStart:
      hoursFromNow === null ? null : new Date(DEMO_NOW.getTime() + hoursFromNow * 3_600_000),
  };
}

/**
 * A board with one of each interesting case: work that fits inside guaranteed
 * hours, work that has to go to the market, an urgent backfill, and a job so
 * far out of zone that the drive flips which W-2 cleaner is cheaper.
 */
export const DEMO_JOBS: DemoJob[] = [
  make("j-1", "Bonnie Cornell",     "3412 Legacy Dr",     "Plano",       "75024", "standard", "biweekly",  2, 2, 26),
  make("j-2", "Ann Lutich",         "781 Ohio Dr",        "Plano",       "75024", "standard", "weekly",    2, 2, 74),
  make("j-3", "Jennifer Vaughn",    "1290 Main St",       "Frisco",      "75034", "deep",     "one_time",  3, 2, 120),
  make("j-4", "Jonathan Ruiz",      "455 Bethany Rd",     "Allen",       "75002", "deep",     "one_time",  3, 2, 18),
  make("j-5", "Tabitha Holmes",     "902 Custer Rd",      "Richardson",  "75080", "standard", "one_time",  3, 2, 8),
  make("j-6", "Sorab Mistry",       "6100 Camp Bowie Blvd", "Fort Worth","76102", "move_in_out", "one_time", 4, 4, 40),
  make("j-7", "Veena Mahadevan",    "2200 Preston Rd",    "Plano",       "75024", "standard", "monthly",   3, 2, null),
];

/**
 * The roster. Shonda and Iggy carry the real terms from the build plan; the
 * marketplace pool is small on purpose — the plan is blunt that below roughly
 * ten active vetted cleaners the waterfall is just sequential phone calls with
 * a nicer interface.
 */
export const DEMO_CLEANERS: Cleaner[] = [
  shonda({ hoursScheduledThisWeek: 31.5, lastStopZip: "75024" }),
  iggy({ hoursScheduledThisWeek: 12, lastStopZip: "75080" }),
  contractor({
    id: "c-marisol", name: "Marisol A.", rating: 4.8, acceptanceRate: 0.86,
    serviceZips: ["75024", "75034", "75002"], lastStopZip: "75034",
  }),
  contractor({
    id: "c-dee", name: "Dee W.", rating: 4.5, acceptanceRate: 0.61,
    serviceZips: ["75024", "75080"], lastStopZip: "75080",
  }),
  contractor({
    id: "c-priya", name: "Priya N.", rating: 4.2, acceptanceRate: 0.94,
    serviceZips: [], lastStopZip: "75002",
  }),
  contractor({
    id: "c-tomas", name: "Tomás R.", rating: 3.6, acceptanceRate: 0.72,
    serviceZips: ["76102"], lastStopZip: "76102",
  }),
  contractor({
    id: "c-janelle", name: "Janelle B.", rating: 4.9, acceptanceRate: 0.55,
    backgroundCheckCleared: false, serviceZips: [], lastStopZip: "75024",
  }),
];

// isDemoMode lives in lib/supabase/env.ts, next to the config it inspects.
