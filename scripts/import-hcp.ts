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

import { readFileSync, writeFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseCsv, toRecords } from "../src/lib/migration/csv.ts";
import {
  mapCustomer,
  mapJob,
  normaliseName,
  normalisePhone,
  type CustomerKeys,
  type MappedAddress,
  type MappedCustomer,
} from "../src/lib/migration/hcp.ts";
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
  /** Rows that imported, but state a cadence the price book cannot sell. */
  cadenceUnsupported: number;
  /** Rows that could not be placed, listed so they can be fixed at the source. */
  unplaceable: string[];
}

function emptyCounts(): Counts {
  return { created: 0, updated: 0, skipped: 0, failed: 0, cadenceUnsupported: 0, unplaceable: [] };
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
 * Not `new Date(string)` for a bare wall clock. The export says 10:00 and means
 * 10:00 in Dallas; a bare parse means 10:00 wherever the laptop is, which is
 * how a migration run from a hotel in another state books three hundred cleans
 * an hour out.
 *
 * WHEN THE EXPORT STATED AN OFFSET, though, the value is already an instant and
 * re-reading its wall clock as Dallas is the bug rather than the fix. The
 * mapper keeps the offset where there was one, so a string carrying `-05:00` or
 * `Z` is parsed as written and only a zoneless one goes through the calendar.
 */
function toInstant(local: string | null): string | null {
  if (!local) return null;

  if (/(Z|[+-]\d{2}:\d{2})$/.test(local)) {
    const absolute = new Date(local);
    return Number.isNaN(absolute.getTime()) ? null : absolute.toISOString();
  }

  const parsed = zonedTimeToUtc(local);
  if (parsed.ok) return parsed.date.toISOString();
  return parsed.reason === "nonexistent" ? parsed.skippedTo.toISOString() : null;
}

async function importCustomers(
  db: SupabaseClient,
  path: string,
  options: Options,
): Promise<{ counts: Counts; book: CustomerBook }> {
  const records = toRecords(parseCsv(readFileSync(path, "utf8")));
  const rows = options.limit ? records.slice(0, options.limit) : records;

  const counts = emptyCounts();
  const book = new CustomerBook();

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
      // Indexed even in a dry run, so the JOBS pass can still check that every
      // job's customer is in the customer file. That cross-file join is the
      // single most useful thing a dry run reports — a jobs export referencing
      // customers the customers export does not contain is the commonest way an
      // HCP migration arrives half-empty, and it is invisible until you look.
      // Keyed by the HCP id rather than one shared placeholder, so the index,
      // the property cache and the address fallback all behave in a dry run
      // exactly as they will in the real one. A single "dry-run" id would
      // collapse every customer into one and report a join that does not exist.
      book.add(customer, `dry:${customer.hcpId}`);
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
    book.add(customer, data);

    // The customer file's own address, where it has one. More than half the
    // rows in a real export do not — the address lives on the job — so this is
    // a head start on the property table rather than the source of it.
    if (customer.address) {
      const propertyId = await upsertProperty(db, data, customer.address);
      if (propertyId) book.rememberProperty(customer.address.hcpAddressId, propertyId);
    }
  }

  return { counts, book };
}

/**
 * The customer file, indexed by everything a job row could use to find it.
 *
 * WHY A CLASS AND NOT A MAP. The jobs export identifies a customer by name,
 * email and phone and carries no id, so the join needs several keys tried in
 * order — and it needs to know when a key is AMBIGUOUS. Two customers sharing a
 * name is ordinary; silently attaching a stranger's cleans to one of them is
 * not, so a name that matches more than one person matches nobody.
 */
class CustomerBook {
  private readonly byHcpId = new Map<string, string>();
  private readonly byDisplayName = new Map<string, string | null>();
  private readonly byEmail = new Map<string, string>();
  private readonly byPhone = new Map<string, string>();
  private readonly byName = new Map<string, string | null>();
  private readonly properties = new Map<string, string>();
  private readonly ownAddress = new Map<string, MappedAddress>();

  add(customer: MappedCustomer, id: string) {
    this.byHcpId.set(customer.hcpId, id);
    if (customer.email) this.byEmail.set(customer.email.toLowerCase(), id);
    if (customer.address) this.ownAddress.set(id, customer.address);

    const phone = customer.phone ? normalisePhone(customer.phone) : null;
    if (phone) this.byPhone.set(phone, id);

    // null marks a key two customers share: present, but not identifying.
    if (customer.displayName) {
      this.byDisplayName.set(
        customer.displayName,
        this.byDisplayName.has(customer.displayName) ? null : id,
      );
    }

    const name = normaliseName(`${customer.firstName} ${customer.lastName}`);
    if (!name) return;
    this.byName.set(name, this.byName.has(name) ? null : id);
  }

  /**
   * Most specific key first.
   *
   * The display name outranks the email deliberately — see `CustomerKeys` — and
   * a key that two customers share identifies neither, so it falls through to
   * the next one rather than picking whichever was read first.
   */
  find(keys: CustomerKeys): string | null {
    if (keys.hcpId) {
      const byId = this.byHcpId.get(keys.hcpId);
      if (byId) return byId;
    }
    if (keys.displayName) {
      const byDisplay = this.byDisplayName.get(keys.displayName);
      if (byDisplay) return byDisplay;
    }
    if (keys.email) {
      const byEmail = this.byEmail.get(keys.email);
      if (byEmail) return byEmail;
    }
    if (keys.phone) {
      const byPhone = this.byPhone.get(keys.phone);
      if (byPhone) return byPhone;
    }
    return keys.name ? (this.byName.get(keys.name) ?? null) : null;
  }

  /** The address from the customer file, for a job row that carries none. */
  addressFor(customerId: string): MappedAddress | undefined {
    return this.ownAddress.get(customerId);
  }

  get size(): number {
    return this.byHcpId.size;
  }

  propertyFor(addressId: string): string | undefined {
    return this.properties.get(addressId);
  }

  rememberProperty(addressId: string, propertyId: string) {
    this.properties.set(addressId, propertyId);
  }
}

async function upsertProperty(
  db: SupabaseClient,
  customerId: string,
  address: MappedAddress,
): Promise<string | null> {
  const { data, error } = await db.rpc("import_property", {
    p_hcp_address_id: address.hcpAddressId,
    p_customer_id: customerId,
    p_street: address.street,
    p_city: address.city,
    p_zip: address.zip,
    p_state: address.state,
  });

  if (error) {
    console.error(`  property failed for ${address.hcpAddressId}: ${error.message}`);
    return null;
  }
  return typeof data === "string" ? data : null;
}

async function importJobs(
  db: SupabaseClient,
  path: string,
  options: Options,
  book: CustomerBook,
): Promise<Counts> {
  const records = toRecords(parseCsv(readFileSync(path, "utf8")));
  const rows = options.limit ? records.slice(0, options.limit) : records;

  const counts = emptyCounts();
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
    if (job.cadenceUnsupported) counts.cadenceUnsupported += 1;

    const customerId = book.find(job.customer);
    if (!customerId) {
      counts.skipped += 1;
      counts.unplaceable.push(`${job.hcpId}\tno matching customer\t${job.customer.displayName ?? ""}`);
      console.warn(
        `  skipped — job ${job.hcpId}: no customer matching ` +
          `${job.customer.displayName ?? job.customer.email ?? job.customer.phone ?? "(nothing)"}`,
      );
      continue;
    }
    // The job row's address first — it is where the cleaner was actually sent
    // — then the customer file's. Only a job with neither is unplaceable.
    const address = job.address ?? book.addressFor(customerId) ?? null;
    if (!address) {
      counts.skipped += 1;
      counts.unplaceable.push(
        `${job.hcpId}\tno address\t${job.customer.displayName ?? ""}\t${job.status}\t${job.scheduledStart ?? ""}`,
      );
      console.warn(`  skipped — job ${job.hcpId}: no address on the job row or the customer`);
      continue;
    }

    if (options.dryRun) {
      counts.created += 1;
      continue;
    }

    // One property per house, not per visit: `import_property` keys on the
    // address id, and the cache keeps a customer's twentieth clean from making
    // a twentieth round trip for a property we already have.
    let propertyId = book.propertyFor(address.hcpAddressId);
    if (!propertyId) {
      const created = await upsertProperty(db, customerId, address);
      if (!created) {
        counts.failed += 1;
        continue;
      }
      propertyId = created;
      book.rememberProperty(address.hcpAddressId, created);
    }

    const { error } = await db.rpc("import_job", {
      p_hcp_id: job.hcpId,
      p_customer_id: customerId,
      p_property_id: propertyId,
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

  let book = new CustomerBook();

  if (options.customers) {
    const result = await importCustomers(db, options.customers, options);
    book = result.book;
    report("customers", result.counts);
  }

  // Jobs need the customer map, so a jobs-only run has to be told to read the
  // customer file too. Saying so beats silently importing nothing.
  if (options.jobs) {
    if (book.size === 0) {
      console.error(
        "\nThe jobs export carries no customer id — jobs are matched to the customer\n" +
          "file by email, phone and name — so --customers has to be passed in the same\n" +
          "run. Nothing was written.",
      );
      process.exit(1);
    }
    report("jobs", await importJobs(db, options.jobs, options, book));
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

  if (counts.cadenceUnsupported > 0) {
    console.log(
      `  ${counts.cadenceUnsupported} ${kind} state a cadence the price book cannot sell\n` +
        `    ("2x a week" and the like). They imported at the price they were sold\n` +
        `    for, so nobody is billed differently — but their frequency is a\n` +
        `    fallback, and they need a decision before anything re-quotes them.`,
    );
  }

  if (counts.unplaceable.length > 0) {
    // Written out rather than only counted: every line is a real clean for a
    // real customer, and a number on a terminal is not something anybody can
    // act on. The fix is in Housecall Pro — add the address, export again.
    const path = `${kind}-unplaceable.tsv`;
    writeFileSync(path, `hcp_id\treason\tcustomer\tstatus\tscheduled\n${counts.unplaceable.join("\n")}\n`);
    console.log(`  ${counts.unplaceable.length} could not be placed — written to ${path}`);
  }

  if (counts.failed > 0) process.exitCode = 1;
}

void main();
