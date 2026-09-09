/**
 * Fixture-backed repository. No network, no credentials, no database.
 *
 * This is not throwaway scaffolding — it is the path that keeps the app
 * reviewable and demoable, and it is what the 148 engine tests exercise.
 */

import { demoCustomers, demoProperties } from "../demo/added";
import { DEMO_CLEANERS, DEMO_JOBS } from "../demo/fixtures";
import type { Repository } from "./repository";
import type { Cleaner, Customer, Job, JobFilter, Profile, Property } from "./types";

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
    lifetimeValueCents: demo.priceCents,
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
    let jobs = DEMO_JOBS.map(toJob);
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
    // Demo mode has no auth; the cleaner view shows the first W-2 cleaner.
    return DEMO_CLEANERS.find((c) => c.type === "w2_core") ?? null;
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

  async getCurrentProfile(): Promise<Profile | null> {
    return null; // nobody is signed in during a demo
  }
}
