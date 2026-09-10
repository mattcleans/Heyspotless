/**
 * Row -> domain mapping.
 *
 * Rows arrive from PostgREST as `unknown`-shaped JSON. Rather than hand-maintain
 * a generated `Database` type that silently drifts from the migrations, every
 * row crosses this boundary through an explicit mapper that reads only the
 * columns it needs and coerces them. A schema change that breaks an assumption
 * surfaces here, in one file, instead of as `undefined` three layers up.
 */

import type { Frequency, ServiceType } from "../pricing/price-book";
import type { Cleaner, W2Terms } from "../dispatch/types";
import type { InvoiceStatus, PaymentStatus } from "../billing/types";
import { toCalendarDate, type CalendarDate } from "../time/zone";
import type {
  Customer,
  Invoice,
  Job,
  Payment,
  PaymentMethod,
  Profile,
  Property,
  UserRole,
} from "./types";

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== "string") throw new Error(`expected string at "${key}", got ${typeof v}`);
  return v;
}

function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === "string" ? v : null;
}

function num(row: Row, key: string, fallback?: number): number {
  const v = row[key];
  if (typeof v === "number") return v;
  // numeric columns come back as strings from PostgREST
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (fallback !== undefined) return fallback;
  throw new Error(`expected number at "${key}", got ${typeof v}`);
}

function numOrNull(row: Row, key: string): number | null {
  const v = row[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function bool(row: Row, key: string): boolean {
  return row[key] === true;
}

function dateOrNull(row: Row, key: string): Date | null {
  const v = row[key];
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A Postgres `date` column. Kept as the day it is rather than parsed into a
 * timestamp, because `new Date("2026-09-15")` is midnight UTC — which is the
 * evening of the 14th in Dallas, and that one line is what made future-due
 * invoices look overdue.
 */
function calendarDateOrNull(row: Row, key: string): CalendarDate | null {
  return toCalendarDate(row[key]);
}

function strArray(row: Row, key: string): string[] {
  const v = row[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A joined one-to-one relation arrives as an object, or an array of one. */
function relation(row: Row, key: string): Row {
  const v = row[key];
  if (Array.isArray(v)) return (v[0] ?? {}) as Row;
  if (v && typeof v === "object") return v as Row;
  return {};
}

export function toProfile(row: Row): Profile {
  return {
    id: str(row, "id"),
    role: str(row, "role") as UserRole,
    fullName: str(row, "full_name"),
    email: strOrNull(row, "email"),
    phone: strOrNull(row, "phone"),
  };
}

export function toCustomer(row: Row): Customer {
  return {
    id: str(row, "id"),
    firstName: str(row, "first_name"),
    lastName: str(row, "last_name"),
    email: strOrNull(row, "email"),
    phone: strOrNull(row, "phone"),
    lifetimeValueCents: num(row, "lifetime_value_cents", 0),
    stripeCustomerId: strOrNull(row, "stripe_customer_id"),
    autopayEnabled: bool(row, "autopay_enabled"),
    autopayAuthorizedAt: dateOrNull(row, "autopay_authorized_at"),
  };
}

export function toProperty(row: Row): Property {
  return {
    id: str(row, "id"),
    customerId: str(row, "customer_id"),
    street: str(row, "street"),
    city: str(row, "city"),
    state: strOrNull(row, "state") ?? "TX",
    zip: str(row, "zip"),
    rooms: {
      bedrooms: num(row, "bedrooms", 0),
      bathrooms: num(row, "bathrooms", 0),
      halfBaths: num(row, "half_baths", 0),
      kitchens: num(row, "kitchens", 1),
      livingRooms: num(row, "living_rooms", 1),
      utilityRooms: num(row, "utility_rooms", 1),
    },
    gateCode: strOrNull(row, "gate_code"),
    accessNotes: strOrNull(row, "access_notes"),
    parkingNotes: strOrNull(row, "parking_notes"),
    pets: strOrNull(row, "pets"),
  };
}

/** Expects `customers(...)` and `properties(...)` to be joined into the select. */
export function toJob(row: Row): Job {
  const customer = relation(row, "customers");
  const property = relation(row, "properties");

  const firstName = strOrNull(customer, "first_name") ?? "";
  const lastName = strOrNull(customer, "last_name") ?? "";

  return {
    id: str(row, "id"),
    customerId: str(row, "customer_id"),
    customerName: `${firstName} ${lastName}`.trim() || "Unknown customer",
    propertyId: str(row, "property_id"),
    street: strOrNull(property, "street") ?? "",
    city: strOrNull(property, "city") ?? "",
    zip: strOrNull(property, "zip") ?? "",
    service: str(row, "service") as ServiceType,
    frequency: str(row, "freq") as Frequency,
    bedrooms: num(property, "bedrooms", 0),
    bathrooms: num(property, "bathrooms", 0),
    status: str(row, "status"),
    priceCents: num(row, "price_cents", 0),
    estimatedCleanMinutes: num(row, "estimated_clean_minutes", 0),
    scheduledStart: dateOrNull(row, "scheduled_start"),
  };
}

/**
 * W-2 terms are only meaningful when an hourly rate is on file. A contractor
 * has no terms, and `w2MarginalCost` returns null for them by design.
 */
function toTerms(row: Row): W2Terms | undefined {
  const hourlyRateCents = numOrNull(row, "hourly_rate_cents");
  if (hourlyRateCents === null) return undefined;

  return {
    hourlyRateCents,
    guaranteedHoursPerWeek: numOrNull(row, "guaranteed_hours_per_week"),
    overtimeThresholdHours: 40,
    overtimeMultiplier: num(row, "overtime_multiplier", 1.5),
    employerBurdenRate: num(row, "employer_burden_rate", 0.15),
    usesCompanyVehicle: bool(row, "uses_company_vehicle"),
    driveTimePaid: row["drive_time_paid"] !== false,
  };
}

export function toCleaner(row: Row): Cleaner {
  return {
    id: str(row, "id"),
    name: str(row, "full_name"),
    type: str(row, "type") as Cleaner["type"],
    status: str(row, "status") as Cleaner["status"],
    rating: numOrNull(row, "rating"),
    acceptanceRate: numOrNull(row, "acceptance_rate"),
    backgroundCheckCleared: bool(row, "background_check_cleared"),
    insuranceExpiresOn: dateOrNull(row, "insurance_expires_on"),
    serviceZips: strArray(row, "service_zips"),
    terms: toTerms(row),
    hoursScheduledThisWeek: num(row, "hours_scheduled_this_week", 0),
  };
}

/**
 * `balance_cents` is a generated column (0006). It is read, never derived here,
 * so that the number on the screen is the number the database will act on when
 * the auto-charge sweep runs.
 */
export function toInvoice(row: Row): Invoice {
  return {
    id: str(row, "id"),
    customerId: str(row, "customer_id"),
    jobId: strOrNull(row, "job_id"),
    status: str(row, "status") as InvoiceStatus,
    amounts: {
      subtotalCents: num(row, "subtotal_cents", 0),
      tipCents: num(row, "tip_cents", 0),
      totalCents: num(row, "total_cents", 0),
      amountPaidCents: num(row, "amount_paid_cents", 0),
      refundedCents: num(row, "refunded_cents", 0),
    },
    balanceCents: num(row, "balance_cents", 0),
    dueOn: calendarDateOrNull(row, "due_on"),
    issuedAt: dateOrNull(row, "issued_at"),
    voidedAt: dateOrNull(row, "voided_at"),
    attemptCount: num(row, "attempt_count", 0),
    nextAttemptAt: dateOrNull(row, "next_attempt_at"),
    lastError: strOrNull(row, "last_error"),
    createdAt: dateOrNull(row, "created_at") ?? new Date(0),
  };
}

export function toPayment(row: Row): Payment {
  return {
    id: str(row, "id"),
    invoiceId: str(row, "invoice_id"),
    amountCents: num(row, "amount_cents", 0),
    status: str(row, "status") as PaymentStatus,
    method: strOrNull(row, "method"),
    isAutocharge: bool(row, "is_autocharge"),
    failureMessage: strOrNull(row, "failure_message"),
    succeededAt: dateOrNull(row, "succeeded_at"),
    createdAt: dateOrNull(row, "created_at") ?? new Date(0),
  };
}

export function toPaymentMethod(row: Row): PaymentMethod {
  return {
    id: str(row, "id"),
    customerId: str(row, "customer_id"),
    stripePaymentMethodId: str(row, "stripe_payment_method_id"),
    brand: strOrNull(row, "brand"),
    last4: strOrNull(row, "last4"),
    expMonth: numOrNull(row, "exp_month"),
    expYear: numOrNull(row, "exp_year"),
    isDefault: bool(row, "is_default"),
  };
}
