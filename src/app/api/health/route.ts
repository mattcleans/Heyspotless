import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasSupabaseConfig, isDemoMode, supabaseUrl } from "@/lib/supabase/env";
import {
  cronSecretMatches,
  hasStripeConfig,
  isBillingEnabled,
  stripePublishableKey,
  stripeWebhookSecret,
} from "@/lib/stripe/env";
import {
  hasTwilioConfig,
  isMessagingEnabled,
  twilioAccountSid,
  twilioAuthToken,
  twilioMessagingServiceSid,
} from "@/lib/messaging/env";

/**
 * Is this deployment actually wired up?
 *
 * WHY THIS EXISTS. Every integration in this app is deliberately switched off
 * until its account exists — billing behind STRIPE_SECRET_KEY, messaging behind
 * the Twilio trio, the whole repository behind DEMO_MODE. That is the right
 * default, and it has one cost: a deployment that is quietly doing nothing
 * looks exactly like a deployment that is working. The Stripe webhook answering
 * "billing is not enabled" and the dispatch sweep reporting zero jobs are both
 * 200s, and neither says whether the key is missing or the flag is off or the
 * database is simply empty.
 *
 * So this endpoint answers, in one call, the question that otherwise takes an
 * afternoon of poking at production: which integrations are configured, whether
 * the database is reachable, what schema level it is at, and whether there is
 * any data in it.
 *
 * WHAT IT WILL NOT DO. It reports booleans and counts, never a key, never a
 * fragment of one. "Configured" means the variable is non-empty — it does not
 * mean the credential is valid, because proving that means spending a live API
 * call against Stripe and Twilio on every health check. The first real send and
 * the first real charge are what prove a key; this proves the wiring.
 *
 * Guarded by CRON_SECRET, like the sweeps, because it runs with no signed-in
 * user and because the shape of a system's configuration is the sort of thing
 * worth not publishing. Without the secret it answers a bare liveness check,
 * which is all an uptime monitor needs.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DatabaseReport {
  reachable: boolean;
  error?: string;
  /**
   * The highest migration this database has applied, as reported by
   * `app_schema_version()`. Null means the function is not there, which means
   * the database predates 0022 — the deploy is ahead of `supabase db push`.
   */
  schemaVersion: number | null;
  /**
   * Row counts for the tables that decide whether this is a working business
   * or an empty shell. A green sweep against an empty database is the most
   * convincing wrong answer this system can give: nothing fails, nothing
   * happens, and the logs say "clean".
   */
  rows?: Record<string, number | null>;
}

export async function GET(request: NextRequest) {
  const presented =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;

  // Liveness, for anything that just needs to know the deployment answers.
  if (!cronSecretMatches(presented)) {
    return NextResponse.json({ ok: true });
  }

  const database = await inspectDatabase();

  return NextResponse.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    deploy: {
      // Set by Vercel on every build. Locally it is absent, which is itself
      // the answer to "am I looking at production?".
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      environment: process.env.VERCEL_ENV ?? "local",
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null,
    },
    supabase: {
      configured: hasSupabaseConfig(),
      // The project ref, not the key. Which project is wired is exactly the
      // thing you want to check before believing a row count.
      projectUrl: supabaseUrl(),
      demoMode: isDemoMode(),
      serviceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    database,
    stripe: {
      secretKey: hasStripeConfig(),
      publishableKey: Boolean(stripePublishableKey()),
      webhookSecret: Boolean(stripeWebhookSecret()),
      // The one that actually decides whether a customer can pay. All three
      // keys present and this false means BILLING_ENABLED=0 is holding it.
      billingEnabled: isBillingEnabled(),
    },
    twilio: {
      accountSid: Boolean(twilioAccountSid()),
      authToken: Boolean(twilioAuthToken()),
      messagingServiceSid: Boolean(twilioMessagingServiceSid()),
      configured: hasTwilioConfig(),
      messagingEnabled: isMessagingEnabled(),
    },
    cron: {
      // True by definition — the caller just proved it by getting this far.
      secret: true,
    },
  });
}

/**
 * One round trip per table, and a failure is a report rather than a throw.
 *
 * `head: true` asks PostgREST for the count without the rows, so this stays
 * cheap enough to call from an uptime monitor every minute.
 */
async function inspectDatabase(): Promise<DatabaseReport> {
  if (isDemoMode()) {
    return { reachable: false, error: "demo mode — no database is connected", schemaVersion: null };
  }

  let db;
  try {
    db = createAdminClient();
  } catch (error) {
    return { reachable: false, error: messageOf(error), schemaVersion: null };
  }

  const TABLES = [
    "customers",
    "properties",
    "cleaners",
    "jobs",
    "recurring_plans",
    "offers",
    "invoices",
    "leads",
    "applications",
    "messages",
  ] as const;

  const [version, ...counts] = await Promise.all([
    db.rpc("app_schema_version").then(
      ({ data, error }) => (error ? null : typeof data === "number" ? data : null),
      () => null,
    ),
    ...TABLES.map((table) =>
      db
        .from(table)
        .select("*", { count: "exact", head: true })
        .then(
          ({ count, error }) => (error ? null : (count ?? 0)),
          () => null,
        ),
    ),
  ]);

  const rows: Record<string, number | null> = {};
  TABLES.forEach((table, i) => {
    rows[table] = counts[i] ?? null;
  });

  // Every count failing means the database is not answering at all; some
  // failing means a table is missing or not readable, which is a migration
  // problem rather than a connection one.
  const reachable = Object.values(rows).some((n) => n !== null);

  return {
    reachable,
    ...(reachable ? {} : { error: "no table could be read" }),
    schemaVersion: version,
    rows,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "unavailable";
}
