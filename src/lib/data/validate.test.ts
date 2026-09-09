import { describe, expect, it } from "vitest";
import { normalizePhone, parseCustomer, parseProperty, type Fields } from "./validate";

/**
 * These are the rules an operator actually runs into: half-typed phone
 * numbers, a Zillow "2.5 ba", a ZIP with a +4 on it. Everything arrives from a
 * form as a string, so the fixtures are strings.
 */
const customer: Fields = {
  firstName: "Dana",
  lastName: "Reyes",
  phone: "(972) 555-0134",
};

const property: Fields = {
  customerId: "cust-1",
  street: "118 Bluebonnet Ln",
  city: "Plano",
  zip: "75024",
  bedrooms: "3",
  bathrooms: "2",
};

describe("normalizePhone", () => {
  it("keeps the ten digits from any formatting", () => {
    for (const raw of ["(972) 555-0134", "972-555-0134", "972.555.0134", "9725550134"]) {
      expect(normalizePhone(raw)).toBe("9725550134");
    }
  });

  it("drops a leading country code", () => {
    expect(normalizePhone("+1 (972) 555-0134")).toBe("9725550134");
  });

  it("rejects anything that is not a US number", () => {
    expect(normalizePhone("555-0134")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });
});

describe("parseCustomer", () => {
  it("accepts a customer with a phone and no email", () => {
    const result = parseCustomer(customer);
    expect(result).toEqual({
      ok: true,
      value: {
        firstName: "Dana",
        lastName: "Reyes",
        email: null,
        phone: "9725550134",
        notes: null,
      },
    });
  });

  it("requires some way to reach them", () => {
    const result = parseCustomer({ firstName: "Dana", lastName: "Reyes" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors["phone"]).toMatch(/email address or a phone/);
  });

  it("reports every problem at once", () => {
    const result = parseCustomer({ email: "not-an-email" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["email", "firstName", "lastName"]);
    }
  });

  it("trims what the operator typed", () => {
    const result = parseCustomer({ ...customer, firstName: "  Dana  " });
    expect(result.ok && result.value.firstName).toBe("Dana");
  });
});

describe("parseProperty", () => {
  it("defaults the rooms nobody fills in, per the schema", () => {
    const result = parseProperty(property);
    expect(result.ok && result.value.rooms).toEqual({
      bedrooms: 3,
      bathrooms: 2,
      halfBaths: 0,
      kitchens: 1,
      livingRooms: 1,
      utilityRooms: 1,
    });
  });

  it("defaults the state to Texas and upper-cases it", () => {
    const unstated = parseProperty(property);
    expect(unstated.ok && unstated.value.state).toBe("TX");

    const oklahoma = parseProperty({ ...property, state: "ok" });
    expect(oklahoma.ok && oklahoma.value.state).toBe("OK");
  });

  it("rejects a ZIP that is not five digits", () => {
    // A ZIP+4 is a real thing to paste in, and the dispatch estimator keys off
    // the five-digit form.
    const result = parseProperty({ ...property, zip: "75024-1234" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors["zip"]).toBeDefined();
  });

  it("rejects a fractional bathroom rather than rounding it", () => {
    // "2.5 ba" is 2 full + 1 half, and quoting prices those differently.
    const result = parseProperty({ ...property, bathrooms: "2.5" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors["bathrooms"]).toMatch(/whole number/);
  });

  it("refuses a property that could never be quoted", () => {
    const result = parseProperty({ ...property, bedrooms: "0", bathrooms: "0" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors["bedrooms"]).toMatch(/at least one/);
  });

  it("keeps the arrival details a cleaner needs", () => {
    const result = parseProperty({
      ...property,
      gateCode: "4417",
      pets: "Two cats, indoor",
      accessNotes: "",
    });
    expect(result.ok && result.value.gateCode).toBe("4417");
    expect(result.ok && result.value.pets).toBe("Two cats, indoor");
    // An empty field is absent, not an empty string.
    expect(result.ok && result.value.accessNotes).toBeNull();
  });
});
