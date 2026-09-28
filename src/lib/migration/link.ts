import {
  streetKey,
  streetMatchKey,
  type MappedCustomer,
  type MappedJob,
} from "./hcp.ts";

/**
 * Which customer a job belongs to, when the export does not say.
 *
 * The 2026 jobs export has no customer id. It repeats the customer's name,
 * email and phone numbers instead, so a job is joined to its customer on those
 * — strongest first, and never by picking one of several:
 *
 *   1. email    — any of the customer's addresses, case-insensitive
 *   2. mobile   — last ten digits, against mobile numbers, then home numbers
 *   3. name     — exact, case-insensitive, against Display Name or First + Last
 *
 * A rule that matches MORE than one customer ends the search. Falling through
 * to a weaker rule would let a shared family email be settled by a name match,
 * which is the evidence the stronger rule just said was not enough. The job is
 * skipped and reported instead.
 */

export type LinkRule = "customer_id" | "email" | "mobile" | "name";

export type PropertySource = "customer" | "job" | "primary";

export interface KnownProperty {
  hcpAddressId: string;
  customerHcpId: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  /** `customer` from the customer export, `job` created from a job's own address. */
  origin: "customer" | "job";
  matchKey: string;
}

export type LinkResult =
  | {
      ok: true;
      customerHcpId: string;
      rule: LinkRule;
      property: KnownProperty;
      propertySource: PropertySource;
    }
  | { ok: false; reason: string; problem: string };

export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function add(map: Map<string, Set<string>>, key: string | null, id: string) {
  if (!key) return;
  const set = map.get(key) ?? new Set<string>();
  set.add(id);
  map.set(key, set);
}

export class CustomerLinker {
  readonly customers = new Map<string, MappedCustomer>();
  private readonly byEmail = new Map<string, Set<string>>();
  private readonly byMobile = new Map<string, Set<string>>();
  private readonly byHome = new Map<string, Set<string>>();
  private readonly byName = new Map<string, Set<string>>();
  /** Every property known for a customer, including ones jobs have added. */
  readonly properties = new Map<string, KnownProperty[]>();

  constructor(customers: readonly MappedCustomer[]) {
    for (const customer of customers) {
      this.customers.set(customer.hcpId, customer);
      for (const email of customer.emails) add(this.byEmail, email, customer.hcpId);
      add(this.byMobile, customer.mobileDigits, customer.hcpId);
      add(this.byHome, customer.homeDigits, customer.hcpId);
      if (customer.displayName) add(this.byName, nameKey(customer.displayName), customer.hcpId);
      const full = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
      if (full) add(this.byName, nameKey(full), customer.hcpId);

      this.properties.set(
        customer.hcpId,
        customer.addresses.map((a) => ({
          hcpAddressId: a.hcpAddressId,
          customerHcpId: customer.hcpId,
          street: a.street,
          city: a.city,
          state: a.state,
          zip: a.zip,
          origin: "customer" as const,
          // Line 1 on both sides: it is what the jobs export repeats.
          matchKey: streetMatchKey(a.line1),
        })),
      );
    }
  }

  /** Customers sharing one email address — each is a job that cannot be linked by email. */
  sharedEmails(): number {
    let n = 0;
    for (const ids of this.byEmail.values()) if (ids.size > 1) n += 1;
    return n;
  }

  /**
   * One customer, from an email or a phone number — how a person identifies a
   * customer in the plans override file. Same no-guessing rule as jobs.
   */
  findByContact(raw: string): { ok: true; hcpId: string } | { ok: false; reason: string } {
    const value = raw.trim().toLowerCase();
    if (value.includes("@")) return this.single("email", this.byEmail.get(value));
    const digits = value.replace(/\D/g, "");
    if (digits.length < 10) return { ok: false, reason: "not an email or a phone number" };
    const key = digits.slice(-10);
    return this.single("mobile", this.byMobile.get(key) ?? this.byHome.get(key));
  }

  private single(
    rule: string,
    ids: Set<string> | undefined,
  ): { ok: true; hcpId: string } | { ok: false; reason: string } {
    if (!ids || ids.size === 0) return { ok: false, reason: "no matching customer" };
    if (ids.size > 1) return { ok: false, reason: `ambiguous customer: ${rule} matched ${ids.size} customers` };
    return { ok: true, hcpId: [...ids][0]! };
  }

  customerFor(
    job: MappedJob,
  ): { ok: true; hcpId: string; rule: LinkRule } | { ok: false; reason: string } {
    if (job.hcpCustomerId) {
      return this.customers.has(job.hcpCustomerId)
        ? { ok: true, hcpId: job.hcpCustomerId, rule: "customer_id" }
        : { ok: false, reason: "no matching customer" };
    }

    const ref = job.customerRef;
    const rules: [LinkRule, Set<string> | undefined][] = [
      ["email", ref.email ? this.byEmail.get(ref.email) : undefined],
      [
        "mobile",
        ref.mobileDigits
          ? (this.byMobile.get(ref.mobileDigits) ?? this.byHome.get(ref.mobileDigits))
          : undefined,
      ],
      ["name", ref.name ? this.byName.get(nameKey(ref.name)) : undefined],
    ];

    for (const [rule, ids] of rules) {
      if (!ids || ids.size === 0) continue;
      if (ids.size > 1) {
        return { ok: false, reason: `ambiguous customer: ${rule} matched ${ids.size} customers` };
      }
      return { ok: true, hcpId: [...ids][0]!, rule };
    }
    return { ok: false, reason: "no matching customer" };
  }

  /**
   * The property a job happened at.
   *
   * The customer's own address when the job's street is one of theirs; a new
   * property from the job's address when it is not (a second home, a rental
   * they manage — 27 customers list more than one); the customer's primary
   * address when the job has no street at all.
   */
  propertyFor(
    customerHcpId: string,
    job: MappedJob,
  ): { ok: true; property: KnownProperty; source: PropertySource } | { ok: false; reason: string } {
    const known = this.properties.get(customerHcpId) ?? [];

    if (!job.address) {
      const primary = known.find((p) => p.origin === "customer");
      return primary ? { ok: true, property: primary, source: "primary" } : { ok: false, reason: "no address" };
    }

    const matchKey = streetMatchKey(job.address.line1);
    const existing = known.find((p) => p.matchKey === matchKey);
    if (existing) return { ok: true, property: existing, source: existing.origin === "job" ? "job" : "customer" };

    if (!job.address.zip) return { ok: false, reason: "job address has no ZIP" };

    const created: KnownProperty = {
      hcpAddressId: `${customerHcpId}:${streetKey(job.address.line1)}`,
      customerHcpId,
      street: job.address.street,
      city: job.address.city,
      state: job.address.state,
      zip: job.address.zip,
      origin: "job",
      matchKey,
    };
    // Remembered, so the next job at `123 Oak St.` finds the property the job
    // at `123 Oak St` created rather than making a second one.
    known.push(created);
    this.properties.set(customerHcpId, known);
    return { ok: true, property: created, source: "job" };
  }

  link(job: MappedJob): LinkResult {
    const customer = this.customerFor(job);
    if (!customer.ok) return { ok: false, reason: customer.reason, problem: `job ${job.hcpId}: ${customer.reason}` };

    const property = this.propertyFor(customer.hcpId, job);
    if (!property.ok) return { ok: false, reason: property.reason, problem: `job ${job.hcpId}: ${property.reason}` };

    return {
      ok: true,
      customerHcpId: customer.hcpId,
      rule: customer.rule,
      property: property.property,
      propertySource: property.source,
    };
  }
}
