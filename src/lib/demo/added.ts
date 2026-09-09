import type { Customer, Property } from "../data/types";
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

export function demoCustomers(): readonly Customer[] {
  return customers;
}

export function demoProperties(): readonly Property[] {
  return properties;
}
