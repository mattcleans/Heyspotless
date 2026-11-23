import type { SupabaseClient } from "@supabase/supabase-js";
import type { CalendarDate } from "../time/zone.ts";
import type { ImportPlan } from "./prepare.ts";

/**
 * Writing a prepared import to the database.
 *
 * Lives here rather than in scripts/import-hcp.ts so it can be tested with a
 * stand-in database. Twice the script's write path was wrong in ways only a
 * live run would show: on 9 November `--apply` stopped calling it at all, and
 * it never passed a completed job's completion date. Both are now asserted.
 *
 * Every write goes through the import_* functions, which key on the Housecall
 * Pro id, so a second run updates what the first wrote.
 */

export interface Counts {
  written: number;
  failed: number;
}

export interface WriteSummary {
  customers: Counts;
  properties: Counts;
  jobs: Counts;
  /** Completed jobs marked as billed in Housecall Pro. */
  billedElsewhere: Counts;
  plans: Counts;
  upcomingVisitsLinked: number;
  /** Any failure anywhere: the caller should exit non-zero. */
  failed: boolean;
}

export interface WriteLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const consoleLog: WriteLog = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export async function writeImport(
  db: SupabaseClient,
  plan: ImportPlan,
  today: CalendarDate,
  log: WriteLog = consoleLog,
): Promise<WriteSummary> {
  const report = (kind: string, counts: Counts) =>
    log.info(`  ${kind}: ${counts.written} written, ${counts.failed} failed`);

  // --- customers -------------------------------------------------------------
  const customerIds = new Map<string, string>();
  const customers: Counts = { written: 0, failed: 0 };
  for (const c of plan.customers) {
    const { data, error } = await db.rpc("import_customer", {
      p_hcp_id: c.hcpId,
      p_first_name: c.firstName,
      p_last_name: c.lastName,
      p_email: c.email,
      p_phone: c.phone,
      p_notes: c.notes,
      p_first_contact_date: c.firstContactDate,
    });
    if (error || typeof data !== "string") {
      customers.failed += 1;
      log.error(`  failed — customer ${c.hcpId}: ${error?.message ?? "no id returned"}`);
      continue;
    }
    customers.written += 1;
    customerIds.set(c.hcpId, data);
  }
  report("customers", customers);

  // --- properties ------------------------------------------------------------
  // Kitchens, living rooms and utility rooms need migration 0029. Against a
  // database without it, PostgREST cannot find a function with those argument
  // names; the import carries on without them rather than stopping, and says so.
  let roomsSupported = true;
  const propertyIds = new Map<string, string>();
  const properties: Counts = { written: 0, failed: 0 };
  for (const p of plan.properties) {
    const customerId = customerIds.get(p.customerHcpId);
    if (!customerId) {
      properties.failed += 1;
      log.error(`  failed — property ${p.hcpAddressId}: its customer was not written`);
      continue;
    }
    const base = {
      p_hcp_address_id: p.hcpAddressId,
      p_customer_id: customerId,
      p_street: p.street,
      p_city: p.city,
      p_zip: p.zip,
      p_state: p.state,
      p_bedrooms: p.rooms?.bedrooms ?? null,
      p_bathrooms: p.rooms?.bathrooms ?? null,
      p_half_baths: p.rooms?.halfBaths ?? null,
    };
    const extra = {
      p_kitchens: p.rooms?.kitchens ?? null,
      p_living_rooms: p.rooms?.livingRooms ?? null,
      p_utility_rooms: p.rooms?.utilityRooms ?? null,
    };

    let result = await db.rpc("import_property", roomsSupported ? { ...base, ...extra } : base);
    if (result.error?.code === "PGRST202" && roomsSupported) {
      roomsSupported = false;
      log.warn(
        "  import_property has no kitchen/living/utility arguments — migration 0029 is not applied.\n" +
          "  Continuing with bedrooms and baths only; re-run after `supabase db push` to add the rest.",
      );
      result = await db.rpc("import_property", base);
    }
    if (result.error || typeof result.data !== "string") {
      properties.failed += 1;
      log.error(`  failed — property ${p.hcpAddressId}: ${result.error?.message ?? "no id returned"}`);
      continue;
    }
    properties.written += 1;
    propertyIds.set(p.hcpAddressId, result.data);
  }
  report("properties", properties);

  // --- jobs ------------------------------------------------------------------
  const jobIds = new Map<string, string>();
  const jobs: Counts = { written: 0, failed: 0 };
  const billedElsewhere: Counts = { written: 0, failed: 0 };
  for (const j of plan.jobs) {
    const customerId = customerIds.get(j.customerHcpId);
    const propertyId = propertyIds.get(j.propertyKey);
    if (!customerId || !propertyId) {
      jobs.failed += 1;
      log.error(`  failed — job ${j.job.hcpId}: its customer or property was not written`);
      continue;
    }
    const { data, error } = await db.rpc("import_job", {
      p_hcp_id: j.job.hcpId,
      p_customer_id: customerId,
      p_property_id: propertyId,
      p_service: j.job.service,
      p_freq: j.freq,
      p_price_cents: j.job.priceCents,
      // Left at zero rather than estimated: the export has no duration, and a
      // made-up estimate would feed the dispatch engine's marginal-cost
      // arithmetic. A zero is visibly missing; a guess is not.
      p_estimated_minutes: 0,
      p_status: j.job.status,
      p_scheduled_start: j.job.scheduledStart,
      p_scheduled_end: j.job.scheduledEnd,
      // Reporting, the at-risk list and visit review all read it.
      p_completed_at: j.job.completedAt,
      p_notes: j.job.notes,
    });
    if (error || typeof data !== "string") {
      jobs.failed += 1;
      log.error(`  failed — job ${j.job.hcpId}: ${error?.message ?? "no id returned"}`);
      continue;
    }
    jobs.written += 1;
    jobIds.set(j.job.hcpId, data);

    // A clean Housecall Pro completed was billed in Housecall Pro, and any
    // balance on it is collected there. Marking it billed keeps it out of
    // Visit review (which lists completed visits awaiting an invoice) and
    // stops this app ever drafting a second invoice for it. Never overwrites.
    if (j.job.status === "complete") {
      const billed = await db
        .from("jobs")
        .update({ invoiced_at: j.job.completedAt ?? j.job.scheduledStart ?? new Date().toISOString() })
        .eq("id", data)
        .is("invoiced_at", null);
      if (billed.error) {
        billedElsewhere.failed += 1;
        log.error(`  failed — job ${j.job.hcpId} not marked as billed in Housecall Pro: ${billed.error.message}`);
      } else {
        billedElsewhere.written += 1;
      }
    }
  }
  report("jobs", jobs);
  report("completed jobs marked as billed in Housecall Pro", billedElsewhere);

  // --- plans -----------------------------------------------------------------
  // A history-only import has none: prepareImport returns no plans to write.
  const plans: Counts = { written: 0, failed: 0 };
  let upcomingVisitsLinked = 0;
  for (const p of plan.plans) {
    const customerId = customerIds.get(p.customerHcpId);
    const propertyId = propertyIds.get(p.propertyKey);
    if (!customerId || !propertyId) {
      plans.failed += 1;
      log.error(`  failed — plan ${p.hcpPlanId}: its customer or property was not written`);
      continue;
    }
    const { data: planId, error } = await db.rpc("import_recurring_plan", {
      p_hcp_plan_id: p.hcpPlanId,
      p_customer_id: customerId,
      p_property_id: propertyId,
      p_freq: p.freq,
      p_service: p.service,
      p_agreed_price_cents: p.agreedPriceCents,
      p_estimated_minutes: 0,
      p_anchor_date: p.anchorDate,
      p_active: p.active,
      ...(p.startTime === null ? {} : { p_start_time: p.startTime }),
    });
    if (error || typeof planId !== "string") {
      plans.failed += 1;
      log.error(`  failed — plan ${p.hcpPlanId}: ${error?.message ?? "no id returned"}`);
      continue;
    }
    plans.written += 1;

    // Upcoming visits HCP already scheduled belong to this plan. Linking them
    // on (plan, occurrence date) is what makes the recurring generator see an
    // occurrence as already generated instead of booking it a second time.
    for (const j of plan.jobs) {
      if (j.planId !== p.hcpPlanId || j.job.status !== "scheduled") continue;
      if (!j.job.scheduledDate || j.job.scheduledDate < today) continue;
      const jobId = jobIds.get(j.job.hcpId);
      if (!jobId) continue;
      const linked = await db
        .from("jobs")
        .update({ recurring_plan_id: planId, occurrence_date: j.job.scheduledDate })
        .eq("id", jobId)
        .is("recurring_plan_id", null);
      if (linked.error) {
        log.warn(`  job ${j.job.hcpId} not linked to its plan: ${linked.error.message}`);
      } else {
        upcomingVisitsLinked += 1;
      }
    }
  }
  report("recurring plans", plans);
  if (plan.plans.length > 0) log.info(`  upcoming visits linked to their plan: ${upcomingVisitsLinked}`);

  const all = [customers, properties, jobs, billedElsewhere, plans];
  return {
    customers,
    properties,
    jobs,
    billedElsewhere,
    plans,
    upcomingVisitsLinked,
    failed: all.some((c) => c.failed > 0),
  };
}
