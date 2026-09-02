/**
 * The data boundary.
 *
 * Everything above this line (pages, the dispatch engine, the quote engine) is
 * ignorant of where data comes from. Two implementations satisfy it: fixtures
 * for demo mode, and Supabase for real. That is what lets the whole app run
 * with no credentials while the same page code serves production.
 */

import type { Cleaner, Customer, Job, JobFilter, Profile, Property } from "./types";

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

  /** The signed-in user, or null in demo mode / when signed out. */
  getCurrentProfile(): Promise<Profile | null>;

  /** True when this repository is serving fixtures rather than real data. */
  readonly isDemo: boolean;
}
