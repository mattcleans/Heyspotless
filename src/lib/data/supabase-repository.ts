import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Repository } from "./repository";
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

/** Jobs in these states still need a cleaner — the dispatch board's working set. */
const NEEDS_CLEANER = ["unscheduled", "scheduled", "dispatching"];

const JOB_SELECT = `
  id, customer_id, property_id, status, service, freq,
  scheduled_start, price_cents, estimated_clean_minutes,
  customers ( first_name, last_name ),
  properties ( street, city, zip, bedrooms, bathrooms )
`;

/**
 * Filtering by cleaner needs an inner join on the assignment, so jobs nobody is
 * assigned to drop out rather than coming back unfiltered.
 */
const JOB_SELECT_FOR_CLEANER = `${JOB_SELECT}, job_assignments!inner ( cleaner_id )`;

const CUSTOMER_SELECT = `
  id, first_name, last_name, email, phone, notes, lifetime_value_cents,
  stripe_customer_id, autopay_enabled, autopay_authorized_at,
  autopay_suspended_at, autopay_suspended_reason
`;

/** `balance_cents` is generated in the database; it is selected, never computed. */
const INVOICE_SELECT = `
  id, customer_id, job_id, status, subtotal_cents, tip_cents, total_cents,
  amount_paid_cents, refunded_cents, balance_cents, due_on, issued_at,
  voided_at, attempt_count, next_attempt_at, last_error, created_at
`;

const PAYMENT_METHOD_SELECT = `
  id, customer_id, stripe_payment_method_id, brand, last4,
  exp_month, exp_year, is_default
`;

const CLEANER_SELECT = `
  id, full_name, type, status, rating, acceptance_rate,
  background_check_cleared, insurance_expires_on, service_zips,
  hourly_rate_cents, guaranteed_hours_per_week, overtime_multiplier,
  employer_burden_rate, uses_company_vehicle, drive_time_paid
`;

type Row = Record<string, unknown>;

function rows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

/**
 * Supabase-backed repository.
 *
 * Takes a client rather than creating one, so the caller decides whose
 * permissions apply: the request-scoped server client (RLS applies, the normal
 * case) or the admin client (webhooks and cron, where there is no user).
 */
export class SupabaseRepository implements Repository {
  readonly isDemo = false;

  constructor(private readonly db: SupabaseClient) {}

  async listJobs(filter: JobFilter = {}): Promise<Job[]> {
    let query = this.db
      .from("jobs")
      .select(filter.cleanerId ? JOB_SELECT_FOR_CLEANER : JOB_SELECT);

    if (filter.needingCleaner) query = query.in("status", NEEDS_CLEANER);
    if (filter.customerId) query = query.eq("customer_id", filter.customerId);
    if (filter.cleanerId) query = query.eq("job_assignments.cleaner_id", filter.cleanerId);
    if (filter.limit !== undefined) query = query.limit(filter.limit);

    // Soonest first; unscheduled jobs sort last, matching dispatchBoard().
    const { data, error } = await query.order("scheduled_start", {
      ascending: true,
      nullsFirst: false,
    });
    if (error) throw new Error(`listJobs: ${error.message}`);

    return rows(data).map(toJob);
  }

  async getJob(id: string): Promise<Job | null> {
    const { data, error } = await this.db
      .from("jobs")
      .select(JOB_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`getJob: ${error.message}`);
    return data ? toJob(data as unknown as Row) : null;
  }

  /**
   * Cleaners, with this week's load merged in from `cleaner_week_load`.
   *
   * Two queries rather than a join: the view has no foreign-key relationship for
   * PostgREST to traverse, and the roster is small enough that a second round
   * trip costs less than the complexity of embedding it.
   */
  async listCleaners(): Promise<Cleaner[]> {
    const [rosterResult, loadResult] = await Promise.all([
      this.db.from("cleaners").select(CLEANER_SELECT).order("full_name"),
      this.db.from("cleaner_week_load").select("cleaner_id, hours_scheduled_this_week, last_stop_zip"),
    ]);

    if (rosterResult.error) throw new Error(`listCleaners: ${rosterResult.error.message}`);
    if (loadResult.error) throw new Error(`listCleaners load: ${loadResult.error.message}`);

    const load = new Map<string, { hours: number; zip?: string }>();
    for (const row of rows(loadResult.data)) {
      const id = row["cleaner_id"];
      if (typeof id !== "string") continue;
      load.set(id, {
        hours: Number(row["hours_scheduled_this_week"] ?? 0),
        zip: typeof row["last_stop_zip"] === "string" ? row["last_stop_zip"] : undefined,
      });
    }

    return rows(rosterResult.data).map((row) => {
      const cleaner = toCleaner(row);
      const l = load.get(cleaner.id);
      return l
        ? { ...cleaner, hoursScheduledThisWeek: l.hours, lastStopZip: l.zip }
        : cleaner;
    });
  }

  async getCleaner(id: string): Promise<Cleaner | null> {
    return (await this.listCleaners()).find((c) => c.id === id) ?? null;
  }

  async getCleanerByProfile(profileId: string): Promise<Cleaner | null> {
    const { data, error } = await this.db
      .from("cleaners")
      .select("id")
      .eq("profile_id", profileId)
      .maybeSingle();
    if (error) throw new Error(`getCleanerByProfile: ${error.message}`);
    const id = (data as Row | null)?.["id"];
    return typeof id === "string" ? this.getCleaner(id) : null;
  }

  async listCustomers(limit = 100): Promise<Customer[]> {
    const { data, error } = await this.db
      .from("customers")
      .select(CUSTOMER_SELECT)
      .order("last_name")
      .limit(limit);
    if (error) throw new Error(`listCustomers: ${error.message}`);
    return rows(data).map(toCustomer);
  }

  async getCustomer(id: string): Promise<Customer | null> {
    const { data, error } = await this.db
      .from("customers")
      .select(CUSTOMER_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`getCustomer: ${error.message}`);
    return data ? toCustomer(data as Row) : null;
  }

  async getCustomerByProfile(profileId: string): Promise<Customer | null> {
    const { data, error } = await this.db
      .from("customers")
      .select(CUSTOMER_SELECT)
      .eq("profile_id", profileId)
      .maybeSingle();
    if (error) throw new Error(`getCustomerByProfile: ${error.message}`);
    return data ? toCustomer(data as Row) : null;
  }

  async getProperty(id: string): Promise<Property | null> {
    const { data, error } = await this.db
      .from("properties")
      .select(
        "id, customer_id, street, city, state, zip, bedrooms, bathrooms, " +
          "half_baths, kitchens, living_rooms, utility_rooms, gate_code, " +
          "access_notes, parking_notes, pets",
      )
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`getProperty: ${error.message}`);
    return data ? toProperty(data as unknown as Row) : null;
  }

  async listProperties(customerId: string): Promise<Property[]> {
    const { data, error } = await this.db
      .from("properties")
      .select(
        "id, customer_id, street, city, state, zip, bedrooms, bathrooms, " +
          "half_baths, kitchens, living_rooms, utility_rooms, gate_code, " +
          "access_notes, parking_notes, pets",
      )
      .eq("customer_id", customerId)
      .order("street");
    if (error) throw new Error(`listProperties: ${error.message}`);
    return rows(data).map(toProperty);
  }

  async listInvoices(filter: InvoiceFilter = {}): Promise<Invoice[]> {
    let query = this.db.from("invoices").select(INVOICE_SELECT);

    if (filter.customerId) query = query.eq("customer_id", filter.customerId);
    // Outstanding is asked of the generated column, so "what is owed" means the
    // same thing here, in the auto-charge sweep, and on the customer's screen.
    if (filter.outstanding) query = query.gt("balance_cents", 0).is("voided_at", null);
    if (filter.limit !== undefined) query = query.limit(filter.limit);

    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw new Error(`listInvoices: ${error.message}`);
    return rows(data).map(toInvoice);
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    const { data, error } = await this.db
      .from("invoices")
      .select(INVOICE_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`getInvoice: ${error.message}`);
    return data ? toInvoice(data as unknown as Row) : null;
  }

  async listPayments(invoiceId: string): Promise<Payment[]> {
    const { data, error } = await this.db
      .from("payments")
      .select(
        "id, invoice_id, amount_cents, status, method, is_autocharge, " +
          "failure_message, succeeded_at, created_at",
      )
      .eq("invoice_id", invoiceId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`listPayments: ${error.message}`);
    return rows(data).map(toPayment);
  }

  /** Detached cards are excluded: they are kept for history, not for charging. */
  async listPaymentMethods(customerId: string): Promise<PaymentMethod[]> {
    const { data, error } = await this.db
      .from("payment_methods")
      .select(PAYMENT_METHOD_SELECT)
      .eq("customer_id", customerId)
      .is("detached_at", null)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw new Error(`listPaymentMethods: ${error.message}`);
    return rows(data).map(toPaymentMethod);
  }

  async getDefaultPaymentMethod(customerId: string): Promise<PaymentMethod | null> {
    return (await this.listPaymentMethods(customerId)).find((m) => m.isDefault) ?? null;
  }

  async getCurrentProfile(): Promise<Profile | null> {
    const { data: auth } = await this.db.auth.getUser();
    if (!auth.user) return null;

    const { data, error } = await this.db
      .from("profiles")
      .select("id, role, full_name, email, phone")
      .eq("id", auth.user.id)
      .maybeSingle();
    if (error) throw new Error(`getCurrentProfile: ${error.message}`);
    return data ? toProfile(data as Row) : null;
  }
}
