/**
 * The data boundary.
 *
 * Everything above this line (pages, the dispatch engine, the quote engine) is
 * ignorant of where data comes from. Two implementations satisfy it: fixtures
 * for demo mode, and Supabase for real. That is what lets the whole app run
 * with no credentials while the same page code serves production.
 */

import type {
  Cleaner,
  Customer,
  Invoice,
  InvoiceFilter,
  Job,
  JobFilter,
  Payment,
  PaymentMethod,
  Profile,
  Property,
} from "./types";

export interface Repository {
  /** Jobs, optionally filtered. Ordered soonest-first; unscheduled last. */
  listJobs(filter?: JobFilter): Promise<Job[]>;
  getJob(id: string): Promise<Job | null>;

  /** The cleaner roster, with the fields dispatch eligibility needs. */
  listCleaners(): Promise<Cleaner[]>;
  getCleaner(id: string): Promise<Cleaner | null>;
  getCleanerByProfile(profileId: string): Promise<Cleaner | null>;

  listCustomers(limit?: number): Promise<Customer[]>;
  getCustomer(id: string): Promise<Customer | null>;
  getCustomerByProfile(profileId: string): Promise<Customer | null>;
  getProperty(id: string): Promise<Property | null>;
  /** Every property belonging to one customer. */
  listProperties(customerId: string): Promise<Property[]>;

  /**
   * Billing reads. Writes deliberately do not live here — the repository is a
   * read boundary for rendering, and every write to the money tables goes
   * through lib/billing/store.ts, which is service-role and audited.
   */
  listInvoices(filter?: InvoiceFilter): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice | null>;
  listPayments(invoiceId: string): Promise<Payment[]>;
  listPaymentMethods(customerId: string): Promise<PaymentMethod[]>;
  getDefaultPaymentMethod(customerId: string): Promise<PaymentMethod | null>;

  /** The signed-in user, or null in demo mode / when signed out. */
  getCurrentProfile(): Promise<Profile | null>;

  /** True when this repository is serving fixtures rather than real data. */
  readonly isDemo: boolean;
}
