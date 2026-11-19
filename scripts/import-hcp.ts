/**
 * Bring the business across from Housecall Pro.
 *
 *   npm run import:hcp -- --customers customers.csv --jobs jobs.csv --dry-run
 *   npm run import:hcp -- --customers customers.csv --jobs jobs.csv [--plans plans.csv] --apply
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
 * freq, service, agreed_price, anchor_date, start_time (Dallas HH:MM), active. A row there always wins
 * over a plan inferred from visit spacing. See `src/lib/migration/plans.ts`.
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseCsv, toRecords } from "../src/lib/migration/csv.ts";
import { formatReport, prepareImport } from "../src/lib/migration/prepare.ts";
import { writeImport } from "../src/lib/migration/write.ts";
import { INVALID_PLAN_START } from "../src/lib/migration/plans.ts";
import { todayIn, toCalendarDate } from "../src/lib/time/zone.ts";

interface Options {
  customers: string | null;
  jobs: string | null;
  plans: string | null;
  dryRun: boolean;
  historyOnly: boolean;
  limit: number | null;
  today: string | null;
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
    dryRun: true,
    historyOnly: false,
    limit: null,
    today: null,
  };

  if (argv.includes("--dry-run") && argv.includes("--apply")) {
    throw new Error("Choose either --dry-run or --apply.");
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--customers") options.customers = argv[++i] ?? null;
    else if (arg === "--jobs") options.jobs = argv[++i] ?? null;
    else if (arg === "--plans") options.plans = argv[++i] ?? null;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--apply") options.dryRun = false;
    else if (arg === "--history-only") options.historyOnly = true;
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

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.customers) {
    console.error(
      "Usage: npm run import:hcp -- --customers customers.csv [--jobs jobs.csv]\n" +
        "         [--plans plans.csv] [--history-only] [--dry-run | --apply] [--limit N] [--today YYYY-MM-DD]\n\n" +
        "Dry run is the default. Use --apply only after reviewing the report. The interesting output of a migration is\n" +
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

  if (options.historyOnly) {
    console.log(
      "HISTORY ONLY — customers, properties and finished jobs are imported. Scheduled\n" +
        "and in-progress visits stay in Housecall Pro, and no recurring plan is written.\n",
    );
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
    historyOnly: options.historyOnly,
  });

  console.log(`as of ${today}\n`);
  console.log(formatReport(plan.report));

  if (options.dryRun) return;
  if (plan.report.skipped.count(INVALID_PLAN_START) > 0) {
    console.error("Correct the invalid recurring arrival times before importing.");
    process.exitCode = 1;
    return;
  }

  console.log("\nwriting:");
  const written = await writeImport(client(), plan, today);
  if (written.failed) process.exitCode = 1;

  console.log(
    "\nNext: check `recurring_price_audit` before anything regenerates a quote.\n" +
      "Every row in it is a customer whose agreed price differs from the book,\n" +
      "and the overcharged ones are money owed back to somebody who trusted us.",
  );
}

void main();
