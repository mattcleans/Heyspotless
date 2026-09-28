import { describe, expect, it } from "vitest";
import { mapCustomer, mapJob, type MappedCustomer, type MappedJob } from "./hcp";
import { CustomerLinker } from "./link";

/**
 * The 2026 jobs export has no customer id. These are the rules that join a job
 * to its customer anyway, and the cases where they must refuse.
 */

function customer(row: Record<string, string>): MappedCustomer {
  const mapped = mapCustomer(row);
  if (!mapped.ok) throw new Error(mapped.problem);
  return mapped.value;
}

function job(row: Record<string, string>): MappedJob {
  const mapped = mapJob({ job: "1", job_amount: "$150.00", ...row });
  if (!mapped.ok) throw new Error(mapped.problem);
  return mapped.value;
}

const paula = customer({
  id: "c1",
  first_name: "Paula",
  last_name: "Marsh",
  display_name: "Paula Marsh",
  email: "paula@example.com",
  additional_emails: "p.marsh@example.com",
  mobile_number: "(214) 555-0101",
  address_1_street_line_1: "100 Oak St",
  address_1_postal_code: "76129",
  address_1_city: "Fort Worth",
});
const dana = customer({
  id: "c2",
  first_name: "Dana",
  last_name: "Reyes",
  home_number: "972-555-0106",
  address_1_street_line_1: "600 Birch Ln",
  address_1_postal_code: "75024",
});
const rob = customer({ id: "c3", first_name: "Rob", last_name: "Nguyen", email: "family@example.com", mobile_number: "214-555-0102" });
const rita = customer({ id: "c4", first_name: "Rita", last_name: "Nguyen", email: "family@example.com", mobile_number: "214-555-0102" });
const chrisA = customer({ id: "c5", first_name: "Chris", last_name: "Lane", display_name: "Chris Lane" });
const chrisB = customer({ id: "c6", first_name: "Chris", last_name: "Lane", display_name: "Chris Lane" });
const company = customer({ id: "c7", company: "Northside Rentals", display_name: "Northside Rentals" });

function linker() {
  return new CustomerLinker([paula, dana, rob, rita, chrisA, chrisB, company]);
}

describe("linking a job to its customer", () => {
  it("links by email, case-insensitively", () => {
    expect(linker().customerFor(job({ customer_email: "PAULA@example.com" }))).toEqual({
      ok: true,
      hcpId: "c1",
      rule: "email",
    });
  });

  it("links by one of the customer's additional emails", () => {
    expect(linker().customerFor(job({ customer_email: "p.marsh@example.com" }))).toMatchObject({ hcpId: "c1" });
  });

  it("links by the last ten digits of the mobile number", () => {
    expect(linker().customerFor(job({ customer_mobile_number: "+1 214.555.0101" }))).toEqual({
      ok: true,
      hcpId: "c1",
      rule: "mobile",
    });
  });

  it("falls back to the customer's home number when no mobile matches", () => {
    expect(linker().customerFor(job({ customer_mobile_number: "9725550106" }))).toEqual({
      ok: true,
      hcpId: "c2",
      rule: "mobile",
    });
  });

  it("links by exact name — Display Name, or First + Last", () => {
    expect(linker().customerFor(job({ customer_name: "  paula   MARSH " }))).toEqual({ ok: true, hcpId: "c1", rule: "name" });
    expect(linker().customerFor(job({ customer_name: "Dana Reyes" }))).toMatchObject({ hcpId: "c2", rule: "name" });
    expect(linker().customerFor(job({ customer_name: "Northside Rentals" }))).toMatchObject({ hcpId: "c7" });
  });

  it("does not match a name partially", () => {
    expect(linker().customerFor(job({ customer_name: "Paula" }))).toEqual({ ok: false, reason: "no matching customer" });
  });

  it("uses the strongest rule that matches, not the first field present", () => {
    // Email matches nobody; the mobile settles it.
    expect(
      linker().customerFor(job({ customer_email: "old@example.com", customer_mobile_number: "2145550101" })),
    ).toMatchObject({ hcpId: "c1", rule: "mobile" });
  });

  /**
   * A shared family email names two customers. Falling through to the name
   * would let weaker evidence settle what the stronger rule said it could not.
   */
  it("refuses an ambiguous email, and does not fall through to a weaker rule", () => {
    const result = linker().customerFor(
      job({ customer_email: "family@example.com", customer_name: "Rob Nguyen" }),
    );
    expect(result).toEqual({ ok: false, reason: "ambiguous customer: email matched 2 customers" });
  });

  it("refuses an ambiguous mobile number", () => {
    expect(linker().customerFor(job({ customer_mobile_number: "2145550102" }))).toEqual({
      ok: false,
      reason: "ambiguous customer: mobile matched 2 customers",
    });
  });

  it("refuses an ambiguous name", () => {
    expect(linker().customerFor(job({ customer_name: "Chris Lane" }))).toEqual({
      ok: false,
      reason: "ambiguous customer: name matched 2 customers",
    });
  });

  it("reports a job whose customer is nowhere in the export", () => {
    expect(linker().customerFor(job({ customer_name: "Zed Unknown", customer_email: "zed@example.com" }))).toEqual({
      ok: false,
      reason: "no matching customer",
    });
  });

  it("still honours a customer id when an older export has one", () => {
    expect(linker().customerFor(job({ customer_id: "c2", customer_name: "Paula Marsh" }))).toEqual({
      ok: true,
      hcpId: "c2",
      rule: "customer_id",
    });
    expect(linker().customerFor(job({ customer_id: "gone" })).ok).toBe(false);
  });
});

describe("the property a job happened at", () => {
  it("uses the customer's own address when the street matches, ignoring punctuation and case", () => {
    const result = linker().link(job({ customer_email: "paula@example.com", street: "100 OAK ST.", zipcode: "76129" }));
    expect(result).toMatchObject({
      ok: true,
      propertySource: "customer",
      property: { hcpAddressId: "c1:100 oak st", origin: "customer" },
    });
  });

  it("creates a property from the job's own address when the customer does not have it", () => {
    const l = linker();
    const result = l.link(
      job({ customer_email: "paula@example.com", street: "12 Lake Rd", city: "Granbury", state: "", zipcode: "76048-1234" }),
    );
    expect(result).toMatchObject({
      ok: true,
      propertySource: "job",
      property: { hcpAddressId: "c1:12 lake rd", street: "12 Lake Rd", city: "Granbury", state: "TX", zip: "76048", origin: "job" },
    });
    expect(l.properties.get("c1")).toHaveLength(2);
  });

  it("finds a job-created property again rather than making a second one", () => {
    const l = linker();
    l.link(job({ customer_email: "paula@example.com", street: "12 Lake Rd", zipcode: "76048" }));
    const again = l.link(job({ customer_email: "paula@example.com", street: "12 Lake Rd.", zipcode: "76048" }));
    expect(again).toMatchObject({ ok: true, property: { hcpAddressId: "c1:12 lake rd" } });
    expect(l.properties.get("c1")).toHaveLength(2);
  });

  it("uses the primary address when the job has no street", () => {
    expect(linker().link(job({ customer_email: "paula@example.com" }))).toMatchObject({
      ok: true,
      propertySource: "primary",
      property: { hcpAddressId: "c1:100 oak st" },
    });
  });

  it("skips a job with no street whose customer has no address either", () => {
    expect(linker().link(job({ customer_name: "Northside Rentals" }))).toMatchObject({ ok: false, reason: "no address" });
  });

  it("skips a new street with no ZIP rather than inventing one", () => {
    expect(linker().link(job({ customer_email: "paula@example.com", street: "999 Other Rd" }))).toMatchObject({
      ok: false,
      reason: "job address has no ZIP",
    });
  });
});

describe("finding a customer from the plans file", () => {
  it("by email or by phone", () => {
    expect(linker().findByContact("Paula@Example.com")).toEqual({ ok: true, hcpId: "c1" });
    expect(linker().findByContact("(972) 555-0106")).toEqual({ ok: true, hcpId: "c2" });
  });

  it("refuses an ambiguous or unknown contact", () => {
    expect(linker().findByContact("family@example.com")).toMatchObject({ ok: false });
    expect(linker().findByContact("nobody@example.com")).toEqual({ ok: false, reason: "no matching customer" });
    expect(linker().findByContact("Paula")).toMatchObject({ ok: false });
  });
});
