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
import type { Invoice, PaymentMethod } from "../data/types";
import { BUSINESS_TIME_ZONE, todayIn, type CalendarDate } from "../time/zone";

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

/**
 * Billing fixtures, one per state the customer screen has to render: settled,
 * outstanding, tipped, and one that auto-charge has already failed on once.
 * The last is the one worth having — an invoice mid-retry is the state that
 * looks fine in isolation and wrong on screen.
 */
function days(n: number): Date {
  return new Date(DEMO_NOW.getTime() + n * 86_400_000);
}

/** The same offset as a business-calendar day, for the `date` columns. */
function dueDay(n: number): CalendarDate {
  return todayIn(BUSINESS_TIME_ZONE, days(n));
}

function invoice(
  id: string,
  subtotalCents: number,
  overrides: Partial<Invoice> = {},
): Invoice {
  const tipCents = overrides.amounts?.tipCents ?? 0;
  const amountPaidCents = overrides.amounts?.amountPaidCents ?? 0;
  const refundedCents = overrides.amounts?.refundedCents ?? 0;
  const totalCents = subtotalCents + tipCents;

  return {
    id,
    // All of Bonnie's: she is the bi-weekly customer in DEMO_JOBS, and a
    // recurring customer accumulating invoices visit after visit is the shape
    // the customer screen actually has to render.
    customerId: "cust-j-1",
    jobId: "j-1",
    status: "sent",
    dueOn: dueDay(-1),
    issuedAt: days(-8),
    voidedAt: null,
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    createdAt: days(-8),
    ...overrides,
    amounts: { subtotalCents, tipCents, totalCents, amountPaidCents, refundedCents },
    balanceCents: totalCents - amountPaidCents + refundedCents,
  };
}

export const DEMO_INVOICES: Invoice[] = [
  // Paid, with a tip — the happy path and the invoice-history row.
  invoice("inv-1", 17000, {
    status: "paid",
    amounts: {
      subtotalCents: 17000,
      tipCents: 2000,
      totalCents: 19000,
      amountPaidCents: 19000,
      refundedCents: 0,
    },
    dueOn: dueDay(-15),
    issuedAt: days(-22),
    createdAt: days(-22),
  }),
  // Outstanding and not yet due — what "Pay now" acts on.
  invoice("inv-2", 17000, { status: "sent", dueOn: dueDay(2) }),
  // Overdue, one failed auto-charge behind it, next attempt scheduled. This is
  // the state that looks fine in isolation and wrong on screen.
  invoice("inv-3", 17000, {
    status: "overdue",
    dueOn: dueDay(-6),
    issuedAt: days(-13),
    createdAt: days(-13),
    attemptCount: 1,
    nextAttemptAt: days(1),
    lastError: "Your card was declined.",
  }),
];

/** One saved card, so the screen renders the card-on-file state rather than the empty one. */
export const DEMO_PAYMENT_METHODS: PaymentMethod[] = [
  {
    id: "pm-1",
    customerId: "cust-j-1",
    stripePaymentMethodId: "pm_demo_visa",
    brand: "visa",
    last4: "4242",
    expMonth: 4,
    expYear: 2030,
    isDefault: true,
  },
];

// isDemoMode lives in lib/supabase/env.ts, next to the config it inspects.
