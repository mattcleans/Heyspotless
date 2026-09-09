import type { PricedJob } from "../data/ops-store";
import type { Customer, Job, Property } from "../data/types";
import type { CustomerInput, PropertyInput } from "../data/validate";

/**
 * Records created while demoing, held in memory for the life of the process.
 *
 * The fixtures in fixtures.ts are read-only and derived from DEMO_JOBS; these
 * are the ones an operator adds by using the app. Keeping them separate means
 * the fixtures stay a fixed, predictable set for the engine tests while the UI
 * is still fully usable with no database behind it.
 *
 * Everything here is lost on restart, which is the correct behaviour for a
 * demo and the reason nothing else in the app may depend on it.
 */
const customers: Customer[] = [];
const properties: Property[] = [];
const jobs: Job[] = [];

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-demo-${counter}`;
}

export function addDemoCustomer(input: CustomerInput, id?: string): Customer {
  const existing = id ? customers.find((c) => c.id === id) : undefined;

  const customer: Customer = {
    id: existing?.id ?? id ?? nextId("cust"),
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    // Lifetime value is recomputed from real invoices, never entered; a new
    // customer has not paid for anything yet.
    lifetimeValueCents: existing?.lifetimeValueCents ?? 0,
    // No Stripe customer until something is charged, and autopay off with no
    // consent timestamp — the pair 0006 requires, and the only honest default
    // for someone who has not authorised anything.
    stripeCustomerId: existing?.stripeCustomerId ?? null,
    autopayEnabled: existing?.autopayEnabled ?? false,
    autopayAuthorizedAt: existing?.autopayAuthorizedAt ?? null,
  };

  if (existing) customers[customers.indexOf(existing)] = customer;
  else customers.push(customer);
  return customer;
}

export function addDemoProperty(input: PropertyInput): Property {
  const property: Property = {
    id: nextId("prop"),
    customerId: input.customerId,
    street: input.street,
    city: input.city,
    state: input.state,
    zip: input.zip,
    rooms: input.rooms,
    gateCode: input.gateCode,
    accessNotes: input.accessNotes,
    parkingNotes: input.parkingNotes,
    pets: input.pets,
  };
  properties.push(property);
  return property;
}

/**
 * A booked job, in the shape the dispatch board reads.
 *
 * The board works from Job (which extends DispatchJob), so a demo booking has
 * to carry the same fields a real row would — the ZIP and the estimated minutes
 * especially, since routing and the offer ladder are computed from them. Denormalising
 * the address and customer name here mirrors what the Supabase repository does
 * with its embedded selects.
 */
export function addDemoJob(priced: PricedJob): Job {
  const property = properties.find((p) => p.id === priced.input.propertyId);
  const customer = customers.find((c) => c.id === priced.customerId);

  const job: Job = {
    id: nextId("job"),
    customerId: priced.customerId,
    customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Customer",
    propertyId: priced.input.propertyId,
    street: property?.street ?? "",
    city: property?.city ?? "",
    zip: property?.zip ?? "",
    service: priced.input.service,
    frequency: priced.input.frequency,
    bedrooms: property?.rooms.bedrooms ?? 0,
    bathrooms: property?.rooms.bathrooms ?? 0,
    status: priced.input.scheduledStart ? "scheduled" : "unscheduled",
    scheduledStart: priced.input.scheduledStart,
    priceCents: priced.priceCents,
    estimatedCleanMinutes: priced.estimatedCleanMinutes,
  };

  jobs.push(job);
  return job;
}

export function demoCustomers(): readonly Customer[] {
  return customers;
}

export function demoJobs(): readonly Job[] {
  return jobs;
}

export function demoProperties(): readonly Property[] {
  return properties;
}
