import { describe, expect, it } from "vitest";
import {
  toCleaner,
  toCustomer,
  toInvoice,
  toJob,
  toPayment,
  toPaymentMethod,
  toProfile,
  toProperty,
} from "./mappers";

/**
 * The mapper layer is where a schema change shows up. These fixtures are shaped
 * exactly as PostgREST returns them — numerics as strings, embedded relations as
 * nested objects, absent values as null — because that is what actually breaks.
 */

describe("toJob", () => {
  const row = {
    id: "job-1",
    customer_id: "cust-1",
    property_id: "prop-1",
    status: "scheduled",
    service: "standard",
    freq: "biweekly",
    scheduled_start: "2026-09-10T15:00:00+00:00",
    price_cents: 17000,
    estimated_clean_minutes: 138,
    customers: { first_name: "Bonnie", last_name: "Cornell" },
    properties: { street: "3412 Legacy Dr", city: "Plano", zip: "75024", bedrooms: 2, bathrooms: 2 },
  };

  it("flattens the joined relations into one shape the engine can consume", () => {
    const job = toJob(row);
    expect(job.customerName).toBe("Bonnie Cornell");
    expect(job.street).toBe("3412 Legacy Dr");
    expect(job.zip).toBe("75024");
    expect(job.priceCents).toBe(17000);
    expect(job.estimatedCleanMinutes).toBe(138);
  });

  it("parses timestamps into Date objects", () => {
    expect(toJob(row).scheduledStart).toBeInstanceOf(Date);
    expect(toJob(row).scheduledStart!.toISOString()).toBe("2026-09-10T15:00:00.000Z");
  });

  it("treats an unscheduled job as null, not as an invalid date", () => {
    expect(toJob({ ...row, scheduled_start: null }).scheduledStart).toBeNull();
  });

  it("accepts a relation returned as a single-element array", () => {
    // PostgREST returns an array when it cannot prove the relation is to-one.
    const job = toJob({
      ...row,
      customers: [{ first_name: "Ann", last_name: "Lutich" }],
      properties: [{ street: "781 Ohio Dr", city: "Plano", zip: "75024", bedrooms: 2, bathrooms: 2 }],
    });
    expect(job.customerName).toBe("Ann Lutich");
    expect(job.street).toBe("781 Ohio Dr");
  });

  it("degrades to a readable label rather than crashing on a missing customer", () => {
    expect(toJob({ ...row, customers: null }).customerName).toBe("Unknown customer");
  });

  it("throws on a missing required column instead of producing NaN downstream", () => {
    const { id: _id, ...withoutId } = row;
    expect(() => toJob(withoutId)).toThrow(/expected string at "id"/);
  });
});

describe("toCleaner", () => {
  const w2 = {
    id: "shonda",
    full_name: "Shonda",
    type: "w2_core",
    status: "active",
    rating: "4.80",
    acceptance_rate: "1.000",
    background_check_cleared: true,
    insurance_expires_on: null,
    service_zips: [],
    hourly_rate_cents: 1750,
    guaranteed_hours_per_week: "40.00",
    overtime_multiplier: "1.50",
    employer_burden_rate: "0.150",
    uses_company_vehicle: true,
    drive_time_paid: true,
  };

  it("coerces numeric columns that PostgREST returns as strings", () => {
    // This is the bug class the mappers exist to prevent: "4.80" >= 3.9 is a
    // string comparison that happens to work, while "4.80" * 1 is not obvious.
    const c = toCleaner(w2);
    expect(c.rating).toBe(4.8);
    expect(typeof c.rating).toBe("number");
    expect(c.terms?.guaranteedHoursPerWeek).toBe(40);
    expect(c.terms?.employerBurdenRate).toBe(0.15);
  });

  it("builds W-2 terms only when an hourly rate is on file", () => {
    expect(toCleaner(w2).terms).toBeDefined();
    const contractor = { ...w2, id: "c1", type: "contractor_1099", hourly_rate_cents: null };
    expect(toCleaner(contractor).terms).toBeUndefined();
  });

  it("keeps a null guarantee null — a part-timer has nothing sunk", () => {
    const iggy = { ...w2, id: "iggy", hourly_rate_cents: 2100, guaranteed_hours_per_week: null };
    expect(toCleaner(iggy).terms?.guaranteedHoursPerWeek).toBeNull();
  });

  it("treats a missing rating as null so the gate rejects rather than admits", () => {
    expect(toCleaner({ ...w2, rating: null }).rating).toBeNull();
  });

  it("defaults drive_time_paid to true, matching the schema default", () => {
    const { drive_time_paid: _d, ...withoutFlag } = w2;
    expect(toCleaner(withoutFlag).terms?.driveTimePaid).toBe(true);
    expect(toCleaner({ ...w2, drive_time_paid: false }).terms?.driveTimePaid).toBe(false);
  });

  it("reads service zones, defaulting to works-anywhere", () => {
    expect(toCleaner({ ...w2, service_zips: ["75024", "75034"] }).serviceZips).toEqual([
      "75024",
      "75034",
    ]);
    expect(toCleaner({ ...w2, service_zips: null }).serviceZips).toEqual([]);
  });
});

describe("toProperty", () => {
  it("gathers room counts into the shape the price book consumes", () => {
    const p = toProperty({
      id: "prop-1",
      customer_id: "cust-1",
      street: "3412 Legacy Dr",
      city: "Plano",
      state: "TX",
      zip: "75024",
      bedrooms: 3,
      bathrooms: 2,
      half_baths: 1,
      kitchens: 1,
      living_rooms: 2,
      utility_rooms: 1,
      gate_code: "4821",
      access_notes: "Side gate",
      parking_notes: null,
      pets: "Two cats",
    });
    expect(p.rooms).toEqual({
      bedrooms: 3,
      bathrooms: 2,
      halfBaths: 1,
      kitchens: 1,
      livingRooms: 2,
      utilityRooms: 1,
    });
    expect(p.gateCode).toBe("4821");
    expect(p.parkingNotes).toBeNull();
  });

  it("applies schema defaults when optional counts are absent", () => {
    const p = toProperty({
      id: "p",
      customer_id: "c",
      street: "1 Main",
      city: "Plano",
      state: "TX",
      zip: "75024",
      bedrooms: 2,
      bathrooms: 1,
    });
    expect(p.rooms.kitchens).toBe(1);
    expect(p.rooms.halfBaths).toBe(0);
  });
});

describe("toCustomer and toProfile", () => {
  it("maps a customer", () => {
    const c = toCustomer({
      id: "c1",
      first_name: "Bonnie",
      last_name: "Cornell",
      email: "bonnie@example.com",
      phone: null,
      lifetime_value_cents: 51000,
    });
    expect(c.lifetimeValueCents).toBe(51000);
    expect(c.phone).toBeNull();
  });

  it("maps a profile", () => {
    const p = toProfile({
      id: "u1",
      role: "admin",
      full_name: "Matt",
      email: "matt@heyspotless.com",
      phone: null,
    });
    expect(p.role).toBe("admin");
  });
});

describe("billing mappers", () => {
  /**
   * `balance_cents` is a generated column, and PostgREST hands numerics back as
   * strings. The mapper must read it rather than recompute it — the number on
   * the screen has to be the number the auto-charge sweep will act on.
   */
  const invoiceRow = {
    id: "inv-1",
    customer_id: "cust-1",
    job_id: "job-1",
    status: "overdue",
    subtotal_cents: 17000,
    tip_cents: 2000,
    total_cents: 19000,
    amount_paid_cents: "5000",
    refunded_cents: 0,
    balance_cents: "14000",
    due_on: "2026-09-01",
    issued_at: "2026-08-25T12:00:00+00:00",
    voided_at: null,
    attempt_count: 2,
    next_attempt_at: "2026-09-12T12:00:00+00:00",
    last_error: "Your card was declined.",
    created_at: "2026-08-25T12:00:00+00:00",
  };

  it("gathers the amounts into the shape the money rules take", () => {
    const invoice = toInvoice(invoiceRow);
    expect(invoice.amounts).toEqual({
      subtotalCents: 17000,
      tipCents: 2000,
      totalCents: 19000,
      amountPaidCents: 5000,
      refundedCents: 0,
    });
    expect(invoice.balanceCents).toBe(14000);
    expect(invoice.status).toBe("overdue");
    expect(invoice.attemptCount).toBe(2);
    expect(invoice.lastError).toBe("Your card was declined.");
  });

  it("parses the dates and tolerates the absent ones", () => {
    const invoice = toInvoice(invoiceRow);
    expect(invoice.dueOn?.getUTCFullYear()).toBe(2026);
    expect(invoice.nextAttemptAt?.toISOString()).toBe("2026-09-12T12:00:00.000Z");
    expect(invoice.voidedAt).toBeNull();
  });

  it("defaults a bare invoice row to zeroes rather than NaN", () => {
    const invoice = toInvoice({ id: "inv-2", customer_id: "cust-1", status: "draft" });
    expect(invoice.amounts.totalCents).toBe(0);
    expect(invoice.balanceCents).toBe(0);
    expect(invoice.jobId).toBeNull();
    expect(invoice.attemptCount).toBe(0);
  });

  it("maps a payment", () => {
    const payment = toPayment({
      id: "pay-1",
      invoice_id: "inv-1",
      amount_cents: 19000,
      status: "succeeded",
      method: "card",
      is_autocharge: true,
      failure_message: null,
      succeeded_at: "2026-09-02T12:00:00+00:00",
      created_at: "2026-09-02T12:00:00+00:00",
    });
    expect(payment.amountCents).toBe(19000);
    expect(payment.isAutocharge).toBe(true);
    expect(payment.succeededAt).toBeInstanceOf(Date);
  });

  it("maps a saved card, and carries no card data beyond the last four", () => {
    const card = toPaymentMethod({
      id: "pm-1",
      customer_id: "cust-1",
      stripe_payment_method_id: "pm_123",
      brand: "visa",
      last4: "4242",
      exp_month: 4,
      exp_year: 2030,
      is_default: true,
    });
    expect(card).toEqual({
      id: "pm-1",
      customerId: "cust-1",
      stripePaymentMethodId: "pm_123",
      brand: "visa",
      last4: "4242",
      expMonth: 4,
      expYear: 2030,
      isDefault: true,
    });
  });

  it("reads autopay consent as a pair", () => {
    const customer = toCustomer({
      id: "cust-1",
      first_name: "Bonnie",
      last_name: "Cornell",
      email: null,
      phone: null,
      lifetime_value_cents: 51000,
      stripe_customer_id: "cus_123",
      autopay_enabled: true,
      autopay_authorized_at: "2026-06-01T00:00:00+00:00",
    });
    expect(customer.autopayEnabled).toBe(true);
    expect(customer.autopayAuthorizedAt).toBeInstanceOf(Date);
    expect(customer.stripeCustomerId).toBe("cus_123");
  });

  it("treats a customer with no Stripe history as not consented", () => {
    const customer = toCustomer({
      id: "cust-2",
      first_name: "Ann",
      last_name: "Lutich",
      email: null,
      phone: null,
      lifetime_value_cents: 0,
    });
    expect(customer.autopayEnabled).toBe(false);
    expect(customer.autopayAuthorizedAt).toBeNull();
    expect(customer.stripeCustomerId).toBeNull();
  });
});
