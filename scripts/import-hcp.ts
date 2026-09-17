/**
 * Bring the business across from Housecall Pro.
 *
 *   node --experimental-strip-types scripts/import-hcp.ts --customers customers.csv --dry-run
 *   node --experimental-strip-types scripts/import-hcp.ts --customers customers.csv --jobs jobs.csv
 *
 * A SCRIPT RATHER THAN A SCREEN, deliberately. This runs a handful of times in
 * one week and then never again; a admin page for it would be a permanent
 * surface with a permanent way to overwrite the customer book. Run from a
 * laptop with the service-role key in the environment, and the key never leaves
 * that laptop.
 *
 * DRY RUN IS THE DEFAULT POSTURE. `--dry-run` reads and maps everything, prints
 * what it would write and every row it could not read, and touches nothing. The
 * first run is always a dry run, because the interesting output of a migration
 * is the list of rows it does NOT understand.
 *
 * TURN MESSAGING OFF FIRST. `MESSAGING_ENABLED=0` in Vercel while this runs.
 * The automation planner already refuses to confirm old bookings
 * (CONFIRMATION_WINDOW_HOURS) or to ask for reviews of imported history
 * (BACKFILL_GRACE_HOURS), and those guards are tested — but the cost of being
 * wrong is texting three hundred people at once, and a flag costs nothing.
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseCsv, toRecords } from "../src/lib/migration/csv.ts";
import { mapCustomer, mapJob } from "../src/lib/migration/hcp.ts";
import { zonedTimeToUtc } from "../src/lib/time/zone.ts";

interface Options {
  customers: string | null;
  jobs: string | null;
  dryRun: boolean;
  limit: number | null;
}

interface Counts {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { customers: null, jobs: null, dryRun: false, limit: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--customers") options.customers = argv[++i] ?? null;
    else if (arg === "--jobs") options.jobs = argv[++i] ?? null;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--limit") options.limit = Number(argv[++i]);
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

/**
 * An export's wall-clock time, resolved through the business calendar.
 *
 * Not `new Date(string)`. The export says 10:00 and means 10:00 in Dallas; a
 * bare parse means 10:00 wherever the laptop is, which is how a migration run
 * from a hotel in another state books three hundred cleans an hour out.
 */
function toInstant(local: string | null): string | null {
  if (!local) return null;
  const parsed = zonedTimeToUtc(local);
  if (parsed.ok) return parsed.date.toISOString();
  return parsed.reason === "nonexistent" ? parsed.skippedTo.toISOString() : null;
}

async function importCustomers(
  db: SupabaseClient,
  path: string,
  options: Options,
): Promise<{ counts: Counts; ids: Map<string, { customerId: string; propertyId: string | null }> }> {
  const records = toRecords(parseCsv(readFileSync(path, "utf8")));
  const rows = options.limit ? records.slice(0, options.limit) : records;

  const counts: Counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const ids = new Map<string, { customerId: string; propertyId: string | null }>();

  console.log(`\ncustomers: ${rows.length} rows from ${path}`);

  for (const row of rows) {
    const mapped = mapCustomer(row);
    if (!mapped.ok) {
      counts.skipped += 1;
      console.warn(`  skipped — ${mapped.problem}`);
      continue;
    }

    const customer = mapped.value;

    if (options.dryRun) {
      counts.created += 1;
      // Recorded even in a dry run, so the JOBS pass can still check that every
      // job's customer is in the customer file. That cross-file join is the
      // single most useful thing a dry run reports — a jobs export referencing
      // customers the customers export does not contain is the commonest way an
      // HCP migration arrives half-empty, and it is invisible until you look.
      ids.set(customer.hcpId, {
        customerId: "dry-run",
        propertyId: customer.address ? "dry-run" : null,
      });
      continue;
    }

    const { data, error } = await db.rpc("import_customer", {
      p_hcp_id: customer.hcpId,
      p_first_name: customer.firstName,
      p_last_name: customer.lastName,
      p_email: customer.email,
      p_phone: customer.phone,
      p_notes: customer.notes,
      p_first_contact_date: customer.firstContactDate,
    });

    if (error || typeof data !== "string") {
      counts.failed += 1;
      console.error(`  failed — customer ${customer.hcpId}: ${error?.message ?? "no id returned"}`);
      continue;
    }
    counts.created += 1;

    let propertyId: string | null = null;
    if (customer.address) {
      const property = await db.rpc("import_property", {
        p_hcp_address_id: customer.address.hcpAddressId,
        p_customer_id: data,
        p_street: customer.address.street,
        p_city: customer.address.city,
        p_zip: customer.address.zip,
        p_state: customer.address.state,
      });
      if (property.error) {
        console.error(`  property failed for ${customer.hcpId}: ${property.error.message}`);
      } else if (typeof property.data === "string") {
        propertyId = property.data;
      }
    }

    ids.set(customer.hcpId, { customerId: data, propertyId });
  }

  return { counts, ids };
}

async function importJobs(
  db: SupabaseClient,
  path: string,
  options: Options,
  ids: Map<string, { customerId: string; propertyId: string | null }>,
): Promise<Counts> {
  const records = toRecords(parseCsv(readFileSync(path, "utf8")));
  const rows = options.limit ? records.slice(0, options.limit) : records;

  const counts: Counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  console.log(`\njobs: ${rows.length} rows from ${path}`);

  for (const row of rows) {
    const mapped = mapJob(row);
    if (!mapped.ok) {
      counts.skipped += 1;
      console.warn(`  skipped — ${mapped.problem}`);
      continue;
    }

    const job = mapped.value;

    // A job whose customer was not in the customer export. Worth reporting
    // rather than inventing a customer for: the two files came from the same
    // system and a gap between them is a fact about the export.
    const owner = ids.get(job.hcpCustomerId);
    if (!owner) {
      counts.skipped += 1;
      console.warn(`  skipped — job ${job.hcpId}: customer ${job.hcpCustomerId} was not imported`);
      continue;
    }
    if (!owner.propertyId) {
      counts.skipped += 1;
      console.warn(`  skipped — job ${job.hcpId}: customer ${job.hcpCustomerId} has no address`);
      continue;
    }

    if (options.dryRun) {
      counts.created += 1;
      continue;
    }

    const { error } = await db.rpc("import_job", {
      p_hcp_id: job.hcpId,
      p_customer_id: owner.customerId,
      p_property_id: owner.propertyId,
      p_service: job.service,
      p_freq: job.frequency,
      p_price_cents: job.priceCents,
      // Left at zero rather than estimated: the export has no duration, and a
      // made-up estimate would feed the dispatch engine's marginal-cost
      // arithmetic. A zero is visibly missing; a guess is not.
      p_estimated_minutes: 0,
      p_status: job.status,
      p_scheduled_start: toInstant(job.scheduledStart),
      p_scheduled_end: null,
      p_completed_at: toInstant(job.completedAt),
      p_notes: job.notes,
    });

    if (error) {
      counts.failed += 1;
      console.error(`  failed — job ${job.hcpId}: ${error.message}`);
      continue;
    }
    counts.created += 1;
  }

  return counts;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.customers && !options.jobs) {
    console.error(
      "Usage: node --experimental-strip-types scripts/import-hcp.ts \\\n" +
        "         --customers customers.csv [--jobs jobs.csv] [--dry-run] [--limit N]\n\n" +
        "Run it with --dry-run first. The interesting output of a migration is\n" +
        "the list of rows it could not read, and a dry run prints exactly that.",
    );
    process.exit(1);
  }

  if (options.dryRun) {
    console.log("DRY RUN — nothing will be written.\n");
  } else {
    console.log(
      "WRITING. Set MESSAGING_ENABLED=0 in Vercel before running this against\n" +
        "a live database: the planner's guards are tested, but the cost of being\n" +
        "wrong is texting several hundred people at once.\n",
    );
  }

  const db = options.dryRun ? (null as unknown as SupabaseClient) : client();

  let ids = new Map<string, { customerId: string; propertyId: string | null }>();

  if (options.customers) {
    const result = await importCustomers(db, options.customers, options);
    ids = result.ids;
    report("customers", result.counts);
  }

  // Jobs need the customer map, so a jobs-only run has to be told to read the
  // customer file too. Saying so beats silently importing nothing.
  if (options.jobs) {
    if (ids.size === 0 && !options.dryRun) {
      console.error(
        "\nJobs reference customers by their Housecall Pro id, so --customers has to be\n" +
          "passed in the same run. Nothing was written.",
      );
      process.exit(1);
    }
    report("jobs", await importJobs(db, options.jobs, options, ids));
  }

  console.log(
    "\nNext: check `recurring_price_audit` before anything regenerates a quote.\n" +
      "Every row in it is a customer whose agreed price differs from the book,\n" +
      "and the overcharged ones are money owed back to somebody who trusted us.",
  );
}

function report(kind: string, counts: Counts) {
  console.log(
    `  ${kind}: ${counts.created} written, ${counts.skipped} skipped, ${counts.failed} failed`,
  );
  if (counts.failed > 0) process.exitCode = 1;
}

void main();
