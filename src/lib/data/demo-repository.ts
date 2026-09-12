/**
 * Fixture-backed repository. No network, no credentials, no database.
 *
 * This is not throwaway scaffolding — it is the path that keeps the app
 * reviewable and demoable, and it is what the 148 engine tests exercise.
 */

import { demoCustomers, demoJobs, demoProperties } from "../demo/added";
import {
  DEMO_CLEANERS,
  DEMO_INVOICES,
  DEMO_JOBS,
  DEMO_PAYMENT_METHODS,
} from "../demo/fixtures";
import { OPENING_RATE_CENTS_PER_HOUR, payoutForRate } from "../dispatch/ladder";
import type { Repository } from "./repository";
import type {
  Cleaner,
  Customer,
  Invoice,
  InvoiceFilter,
  Job,
  JobFilter,
  Offer,
  Payment,
  PaymentMethod,
  Profile,
  Property,
} from "./types";

function toJob(demo: (typeof DEMO_JOBS)[number]): Job {
  return {
    ...demo,
    customerId: `cust-${demo.id}`,
    propertyId: `prop-${demo.id}`,
    status: "unscheduled",
  };
}

function toCustomer(demo: (typeof DEMO_JOBS)[number]): Customer {
  const [firstName = "", ...rest] = demo.customerName.split(" ");
  return {
    id: `cust-${demo.id}`,
    firstName,
    lastName: rest.join(" "),
    email: null,
    phone: null,
    notes: null,
    lifetimeValueCents: demo.priceCents,
    stripeCustomerId: null,
    // Demo mode has consent recorded so the customer screen renders the
    // card-on-file state; there is no Stripe account behind it to charge.
    autopayEnabled: true,
    autopayAuthorizedAt: new Date("2026-06-01T00:00:00Z"),
    autopayEndedAt: null,
    autopayEndedReason: null,
  };
}

/** A fixture job's property, in the shape the schema would have stored. */
function jobProperty(demo: (typeof DEMO_JOBS)[number]): Property {
  return {
    id: `prop-${demo.id}`,
    customerId: `cust-${demo.id}`,
    street: demo.street,
    city: demo.city,
    state: "TX",
    zip: demo.zip,
    rooms: { bedrooms: demo.bedrooms, bathrooms: demo.bathrooms },
    gateCode: null,
    accessNotes: null,
    parkingNotes: null,
    pets: null,
  };
}

export class DemoRepository implements Repository {
  readonly isDemo = true;

  async listJobs(filter: JobFilter = {}): Promise<Job[]> {
    // Booked first, so a job someone has just created is visible without
    // scrolling past the fixtures.
    let jobs = [...demoJobs()].reverse().concat(DEMO_JOBS.map(toJob));
    if (filter.customerId) jobs = jobs.filter((j) => j.customerId === filter.customerId);
    // Demo mode has no assignments table; every job is visible to the one
    // cleaner the demo signs in as.
    if (filter.needingCleaner) jobs = jobs.filter((j) => j.status !== "assigned");
    if (filter.limit !== undefined) jobs = jobs.slice(0, filter.limit);
    return jobs;
  }

  async getJob(id: string): Promise<Job | null> {
    const found = DEMO_JOBS.find((j) => j.id === id);
    return found ? toJob(found) : null;
  }

  async listCleaners(): Promise<Cleaner[]> {
    return [...DEMO_CLEANERS];
  }

  async getCleaner(id: string): Promise<Cleaner | null> {
    return DEMO_CLEANERS.find((c) => c.id === id) ?? null;
  }

  async getCleanerByProfile(): Promise<Cleaner | null> {
    // Demo mode has no auth. The cleaner view signs in as a CONTRACTOR rather
    // than a W-2: offers, countdowns and an exclusive hold are the contractor
    // experience, and a W-2 cleaner is assigned her work rather than offered
    // it. Demoing the offer screen as an employee would be demoing something
    // that does not happen.
    return (
      DEMO_CLEANERS.find((c) => c.type === "contractor_1099") ??
      DEMO_CLEANERS[0] ??
      null
    );
  }

  /**
   * Two live offers, built from the fixture jobs at the published opening
   * rate, so the screen shows the two cases that actually differ: a customer
   * who is already hers and is being held for her, and an ordinary job off the
   * open board.
   *
   * Expiries are relative to now, so the countdowns are live every time the
   * page is loaded rather than long expired.
   */
  async listLiveOffers(cleanerId: string): Promise<Offer[]> {
    const now = Date.now();

    const offerFor = (
      jobId: string,
      isExclusive: boolean,
      expiresInMinutes: number,
    ): Offer | null => {
      const demo = DEMO_JOBS.find((j) => j.id === jobId);
      if (!demo) return null;
      return {
        id: `offer-${jobId}`,
        jobId: demo.id,
        cleanerId,
        payoutCents: payoutForRate(OPENING_RATE_CENTS_PER_HOUR, demo.estimatedCleanMinutes),
        estimatedMinutes: demo.estimatedCleanMinutes,
        expiresAt: new Date(now + expiresInMinutes * 60_000),
        isExclusive,
        customerName: demo.customerName,
        street: demo.street,
        city: demo.city,
        zip: demo.zip,
        scheduledStart: demo.scheduledStart,
      };
    };

    return [
      offerFor("j-2", true, 8 * 60), // Ann is weekly — hers, held for her.
      offerFor("j-5", false, 22),
    ].filter((o): o is Offer => o !== null);
  }

  async listCustomers(limit?: number): Promise<Customer[]> {
    // Newest first: someone who has just added a customer expects to see them.
    const all = [...demoCustomers()].reverse().concat(DEMO_JOBS.map(toCustomer));
    return limit === undefined ? all : all.slice(0, limit);
  }

  async getCustomer(id: string): Promise<Customer | null> {
    return (
      demoCustomers().find((c) => c.id === id) ??
      DEMO_JOBS.map(toCustomer).find((c) => c.id === id) ??
      null
    );
  }

  async listProperties(customerId: string): Promise<Property[]> {
    const added = demoProperties().filter((p) => p.customerId === customerId);
    const fromJobs = DEMO_JOBS.filter((j) => `cust-${j.id}` === customerId).map((j) =>
      jobProperty(j),
    );
    return [...added, ...fromJobs];
  }

  async getCustomerByProfile(): Promise<Customer | null> {
    const first = DEMO_JOBS[0];
    return first ? toCustomer(first) : null;
  }

  async getProperty(id: string): Promise<Property | null> {
    const added = demoProperties().find((p) => p.id === id);
    if (added) return added;
    const demo = DEMO_JOBS.find((j) => `prop-${j.id}` === id);
    return demo ? jobProperty(demo) : null;
  }

  async listInvoices(filter: InvoiceFilter = {}): Promise<Invoice[]> {
    let invoices = [...DEMO_INVOICES];
    if (filter.customerId) invoices = invoices.filter((i) => i.customerId === filter.customerId);
    if (filter.outstanding) invoices = invoices.filter((i) => i.balanceCents > 0 && !i.voidedAt);
    if (filter.limit !== undefined) invoices = invoices.slice(0, filter.limit);
    return invoices;
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    return DEMO_INVOICES.find((i) => i.id === id) ?? null;
  }

  async listPayments(invoiceId: string): Promise<Payment[]> {
    // The fixtures carry settled totals rather than a payment ledger; there is
    // nothing a demo can show here that the invoice does not already say.
    void invoiceId;
    return [];
  }

  async listPaymentMethods(customerId: string): Promise<PaymentMethod[]> {
    return DEMO_PAYMENT_METHODS.map((m) => ({ ...m, customerId }));
  }

  async getDefaultPaymentMethod(customerId: string): Promise<PaymentMethod | null> {
    return (await this.listPaymentMethods(customerId)).find((m) => m.isDefault) ?? null;
  }

  async getCurrentProfile(): Promise<Profile | null> {
    return null; // nobody is signed in during a demo
  }
}
