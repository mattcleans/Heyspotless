/**
 * Bring the business across from Housecall Pro.
 *
 *   npm run import:hcp -- --customers customers.csv --jobs jobs.csv --dry-run
 *   npm run import:hcp -- --customers customers.csv --jobs jobs.csv [--plans plans.csv]
 *
 * A SCRIPT RATHER THAN A SCREEN, deliberately. This runs a handful of times in
 * one week and then never again; a admin page for it would be a permanent
 * surface with a permanent way to overwrite the customer book. Run from a
 * laptop with the service-role key in the environment, and the key never leaves
 * that laptop.
 *
 * DRY RUN IS THE DEFAULT POSTURE. `--dry-run` reads, maps, links jobs to
 * customers and works out every plan, prints the report, and touches nothing —
 * it needs no environment variables at all. The first run is always a dry run,
 * because the interesting output of a migration is the list of rows it does NOT
 * understand. The real run prints the same report and then writes exactly what
 * it describes: both go through `prepareImport`, so they cannot disagree.
 *
 * TURN MESSAGING OFF FIRST. `MESSAGING_ENABLED=0` in Vercel while this runs.
 * The automation planner already refuses to confirm old bookings
 * (CONFIRMATION_WINDOW_HOURS) or to ask for reviews of imported history
 * (BACKFILL_GRACE_HOURS), and those guards are tested — but the cost of being
 * wrong is texting three hundred people at once, and a flag costs nothing.
 *
 * `--plans plans.csv` is optional: columns customer_email_or_phone, street,
 * freq, service, agreed_price, anchor_date, active. A row there always wins
 * over a plan inferred from visit spacing. See `src/lib/migration/plans.ts`.
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseCsv, toRecords } from "../src/lib/migration/csv.ts";
import { formatReport, prepareImport, type ImportPlan } from "../src/lib/migration/prepare.ts";
import { todayIn, toCalendarDate, type CalendarDate } from "../src/lib/time/zone.ts";

interface Options {
  customers: string | null;
  jobs: string | null;
  plans: string | null;
  dryRun: boolean;
  limit: number | null;
  today: string | null;
}

interface Counts {
  written: number;
  failed: number;
}

// Also checked by scripts/check-node.mjs before this file is even parsed; this
// covers somebody running `node --experimental-strip-types` on it by hand.
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 6)) {
  console.error(`Node 22.6 or newer is required; this is Node ${process.versions.node}.`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    customers: null,
    jobs: null,
    plans: null,
    dryRun: false,
    limit: null,
    today: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--customers") options.customers = argv[++i] ?? null;
    else if (arg === "--jobs") options.jobs = argv[++i] ?? null;
    else if (arg === "--plans") options.plans = argv[++i] ?? null;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--limit") options.limit = Number(argv[++i]);
    // For re-running a dry run as of a given day; defaults to today in Dallas.
    else if (arg === "--today") options.today = argv[++i] ?? null;
  }

  return options;
}

function client(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n" +
        "The service role key bypasses row-level security — run this from a laptop, never from CI.",
    );
    process.exit(1);
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

function read(path: string, limit: number | null): Record<string, string>[] {
  const records = toRecords(parseCsv(readFileSync(path, "utf8")));
  return limit ? records.slice(0, limit) : records;
}

function report(kind: string, counts: Counts) {
  console.log(`  ${kind}: ${counts.written} written, ${counts.failed} failed`);
  if (counts.failed > 0) process.exitCode = 1;
}

async function write(db: SupabaseClient, plan: ImportPlan, today: CalendarDate) {
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
      console.error(`  failed — customer ${c.hcpId}: ${error?.message ?? "no id returned"}`);
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
      console.error(`  failed — property ${p.hcpAddressId}: its customer was not written`);
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
      console.warn(
        "  import_property has no kitchen/living/utility arguments — migration 0029 is not applied.\n" +
          "  Continuing with bedrooms and baths only; re-run after `supabase db push` to add the rest.",
      );
      result = await db.rpc("import_property", base);
    }
    if (result.error || typeof result.data !== "string") {
      properties.failed += 1;
      console.error(`  failed — property ${p.hcpAddressId}: ${result.error?.message ?? "no id returned"}`);
      continue;
    }
    properties.written += 1;
    propertyIds.set(p.hcpAddressId, result.data);
  }
  report("properties", properties);

  // --- jobs ------------------------------------------------------------------
  const jobIds = new Map<string, string>();
  const jobs: Counts = { written: 0, failed: 0 };
  for (const j of plan.jobs) {
    const customerId = customerIds.get(j.customerHcpId);
    const propertyId = propertyIds.get(j.propertyKey);
    if (!customerId || !propertyId) {
      jobs.failed += 1;
      console.error(`  failed — job ${j.job.hcpId}: its customer or property was not written`);
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
      p_scheduled_end: null,
      p_completed_at: j.job.completedAt,
      p_notes: j.job.notes,
    });
    if (error) {
      jobs.failed += 1;
      console.error(`  failed — job ${j.job.hcpId}: ${error.message}`);
      continue;
    }
    jobs.written += 1;
    if (typeof data === "string") jobIds.set(j.job.hcpId, data);
  }
  report("jobs", jobs);

  // --- plans -----------------------------------------------------------------
  const plans: Counts = { written: 0, failed: 0 };
  let linkedVisits = 0;
  for (const p of plan.plans) {
    const customerId = customerIds.get(p.customerHcpId);
    const propertyId = propertyIds.get(p.propertyKey);
    if (!customerId || !propertyId) {
      plans.failed += 1;
      console.error(`  failed — plan ${p.hcpPlanId}: its customer or property was not written`);
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
    });
    if (error || typeof planId !== "string") {
      plans.failed += 1;
      console.error(`  failed — plan ${p.hcpPlanId}: ${error?.message ?? "no id returned"}`);
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
        console.warn(`  job ${j.job.hcpId} not linked to its plan: ${linked.error.message}`);
      } else {
        linkedVisits += 1;
      }
    }
  }
  report("recurring plans", plans);
  console.log(`  upcoming visits linked to their plan: ${linkedVisits}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.customers) {
    console.error(
      "Usage: npm run import:hcp -- --customers customers.csv [--jobs jobs.csv]\n" +
        "         [--plans plans.csv] [--dry-run] [--limit N] [--today YYYY-MM-DD]\n\n" +
        "Run it with --dry-run first. The interesting output of a migration is\n" +
        "the list of rows it could not read, and a dry run prints exactly that.\n" +
        (options.jobs
          ? "\nJobs are linked to customers from the customer export, so --customers is required.\n"
          : ""),
    );
    process.exit(1);
  }

  const today = options.today ? toCalendarDate(options.today) : todayIn();
  if (!today) {
    console.error(`--today must be YYYY-MM-DD, not ${options.today}`);
    process.exit(1);
  }

  console.log(
    options.dryRun
      ? "DRY RUN — nothing will be written.\n"
      : "WRITING. Set MESSAGING_ENABLED=0 in Vercel before running this against\n" +
          "a live database: the planner's guards are tested, but the cost of being\n" +
          "wrong is texting several hundred people at once.\n",
  );

  const plan = prepareImport({
    customers: read(options.customers, options.limit),
    jobs: options.jobs ? read(options.jobs, options.limit) : [],
    plans: options.plans ? read(options.plans, null) : [],
    today,
  });

  console.log(`as of ${today}\n`);
  console.log(formatReport(plan.report));

  if (options.dryRun) return;

  console.log("\nwriting:");
  await write(client(), plan, today);

  console.log(
    "\nNext: check `recurring_price_audit` before anything regenerates a quote.\n" +
      "Every row in it is a customer whose agreed price differs from the book,\n" +
      "and the overcharged ones are money owed back to somebody who trusted us.",
  );
}

void main();
