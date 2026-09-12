import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addDemoCustomer,
  addDemoJob,
  addDemoProperty,
  addDemoRecurringPlan,
} from "../demo/added";
import { toCustomer, toProperty } from "./mappers";
import type { Customer, Property } from "./types";
import type { CustomerInput, JobInput, PropertyInput } from "./validate";

/**
 * Operator-driven writes — the counterpart to Repository, which reads.
 *
 * Two stores write in this app and the difference between them is the point.
 * BillingStore takes the SERVICE-ROLE client, because the Stripe webhook and
 * the auto-charge sweep run with no signed-in user and row-level security has
 * nobody to apply. Everything here happens because an admin clicked something,
 * so it takes the request-scoped client and RLS applies exactly as it does to
 * the reads. `customers_admin_all` and `properties_admin_all` in 0003 are what
 * actually permit these writes; a non-admin session gets nothing back.
 *
 * Nothing here decides anything either. Validation lives in validate.ts, which
 * is pure and tested; this converts a validated value to columns and inserts it.
 */
export interface OpsStore {
  createCustomer(input: CustomerInput): Promise<Customer>;
  updateCustomer(id: string, input: CustomerInput): Promise<Customer>;
  createProperty(input: PropertyInput): Promise<Property>;
  /**
   * Book a clean. The caller supplies the priced job because pricing needs the
   * property's rooms, which is a read — see bookJob() in the action.
   */
  createJob(input: PricedJob): Promise<void>;
  /**
   * Start a recurring plan, and return its id.
   *
   * The agreed rate is stored ON THE PLAN. That is the fix for the live
   * overbilling bug in build-plan section 09: a recurring customer's price
   * must never be silently re-derived from a price book that has since moved.
   * What they said yes to is what they pay, until somebody changes it on
   * purpose.
   */
  createRecurringPlan(input: PricedPlan): Promise<string>;
}

/**
 * A recurring plan with its price resolved, and the first visit's date.
 *
 * Separate from PricedJob for the same reason PricedJob is separate from
 * JobInput: the price is computed server-side from the price book and the
 * property's stored rooms, and keeping the priced shape distinct is what
 * makes that impossible to forget.
 */
export interface PricedPlan {
  customerId: string;
  propertyId: string;
  service: string;
  frequency: string;
  /** The first visit. The whole cadence derives from it. */
  anchorDate: string;
  /** Local wall clock in business time, `HH:mm`. */
  startTime: string;
  agreedPriceCents: number;
  estimatedMinutes: number;
  notes: string | null;
}

/**
 * A booking with its price resolved.
 *
 * The price is not part of JobInput and never comes from the form: it is
 * computed from the price book and the property's stored room counts, so a
 * browser cannot post its own total. Keeping the priced shape separate from the
 * parsed shape is what makes that impossible to forget.
 */
export interface PricedJob {
  input: JobInput;
  customerId: string;
  priceCents: number;
  estimatedCleanMinutes: number;
}

/** The domain shape as columns. One place to keep the mapping honest. */
function customerColumns(input: CustomerInput) {
  return {
    first_name: input.firstName,
    last_name: input.lastName,
    email: input.email,
    phone: input.phone,
    notes: input.notes,
  };
}

function propertyColumns(input: PropertyInput) {
  return {
    customer_id: input.customerId,
    street: input.street,
    city: input.city,
    state: input.state,
    zip: input.zip,
    bedrooms: input.rooms.bedrooms,
    bathrooms: input.rooms.bathrooms,
    half_baths: input.rooms.halfBaths,
    kitchens: input.rooms.kitchens,
    living_rooms: input.rooms.livingRooms,
    utility_rooms: input.rooms.utilityRooms,
    gate_code: input.gateCode,
    access_notes: input.accessNotes,
    parking_notes: input.parkingNotes,
    pets: input.pets,
  };
}

/**
 * `notes` is in this list deliberately. It was missing, and because the edit
 * form writes every column it knows about, a customer read back without their
 * notes was a customer whose notes the next "save changes" erased.
 */
const CUSTOMER_COLS = "id, first_name, last_name, email, phone, notes, lifetime_value_cents";
const PROPERTY_COLS =
  `id, customer_id, street, city, state, zip, bedrooms, bathrooms, half_baths, ` +
  `kitchens, living_rooms, utility_rooms, gate_code, access_notes, parking_notes, pets`;

export class SupabaseOpsStore implements OpsStore {
  constructor(private readonly db: SupabaseClient) {}

  async createCustomer(input: CustomerInput): Promise<Customer> {
    const { data, error } = await this.db
      .from("customers")
      .insert(customerColumns(input))
      .select(CUSTOMER_COLS)
      .single();
    if (error) throw new Error(`createCustomer: ${error.message}`);
    return toCustomer(data as unknown as Record<string, unknown>);
  }

  async updateCustomer(id: string, input: CustomerInput): Promise<Customer> {
    const { data, error } = await this.db
      .from("customers")
      .update(customerColumns(input))
      .eq("id", id)
      .select(CUSTOMER_COLS)
      .single();
    if (error) throw new Error(`updateCustomer: ${error.message}`);
    return toCustomer(data as unknown as Record<string, unknown>);
  }

  async createProperty(input: PropertyInput): Promise<Property> {
    const { data, error } = await this.db
      .from("properties")
      .insert(propertyColumns(input))
      .select(PROPERTY_COLS)
      .single();
    if (error) throw new Error(`createProperty: ${error.message}`);
    return toProperty(data as unknown as Record<string, unknown>);
  }

  async createRecurringPlan(plan: PricedPlan): Promise<string> {
    const { data, error } = await this.db
      .from("recurring_plans")
      .insert({
        customer_id: plan.customerId,
        property_id: plan.propertyId,
        service: plan.service,
        freq: plan.frequency,
        anchor_date: plan.anchorDate,
        start_time: plan.startTime,
        agreed_price_cents: plan.agreedPriceCents,
        estimated_minutes: plan.estimatedMinutes,
        next_job_date: plan.anchorDate,
        notes: plan.notes,
        active: true,
      })
      .select("id")
      .single();
    if (error) throw new Error(`createRecurringPlan: ${error.message}`);

    const id = (data as Record<string, unknown> | null)?.["id"];
    if (typeof id !== "string") throw new Error("createRecurringPlan: no id returned");
    return id;
  }

  async createJob(job: PricedJob): Promise<void> {
    const { error } = await this.db.from("jobs").insert({
      customer_id: job.customerId,
      property_id: job.input.propertyId,
      // A job with no slot yet is 'unscheduled', which is what the dispatch
      // board's working set filters on — not a placeholder for a missing date.
      status: job.input.scheduledStart ? "scheduled" : "unscheduled",
      service: job.input.service,
      freq: job.input.frequency,
      scheduled_start: job.input.scheduledStart?.toISOString() ?? null,
      price_cents: job.priceCents,
      estimated_clean_minutes: job.estimatedCleanMinutes,
      notes: job.input.notes,
    });
    if (error) throw new Error(`createJob: ${error.message}`);
  }
}

/**
 * Demo writes, held in memory for the life of the server process.
 *
 * Without this the whole admin UI stops being demoable the moment it grows a
 * form, which would give up the property the README leads with — that the app
 * runs with no Supabase, Stripe or Twilio at all. Nothing here persists, and
 * that is the honest behaviour for a demo.
 */
export class DemoOpsStore implements OpsStore {
  async createCustomer(input: CustomerInput): Promise<Customer> {
    return addDemoCustomer(input);
  }

  async updateCustomer(id: string, input: CustomerInput): Promise<Customer> {
    return addDemoCustomer(input, id);
  }

  async createProperty(input: PropertyInput): Promise<Property> {
    return addDemoProperty(input);
  }

  async createJob(job: PricedJob): Promise<void> {
    addDemoJob(job);
  }

  async createRecurringPlan(plan: PricedPlan): Promise<string> {
    return addDemoRecurringPlan(plan);
  }
}
