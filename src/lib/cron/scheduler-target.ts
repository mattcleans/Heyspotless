const PRODUCTION_ORIGIN = "https://app.heyspotless.com";
const PRODUCTION_DATABASE = "https://swxaupitauibkatljfnt.supabase.co";

/** Read-only preflight for the production GitHub Actions sweeps. */
export async function verifySchedulerTarget(
  appUrl: string | undefined,
  secret: string | undefined,
  fetcher: typeof fetch = fetch,
  requirements: { dispatchRead?: boolean } = {},
): Promise<void> {
  if (!appUrl || !secret) {
    throw new Error("Set APP_URL and CRON_SECRET in GitHub repository secrets.");
  }

  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new Error("APP_URL must be https://app.heyspotless.com.");
  }
  if (
    url.origin !== PRODUCTION_ORIGIN || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("APP_URL must be https://app.heyspotless.com.");
  }

  let response: Response;
  try {
    response = await fetcher(new URL("/api/health", url), {
      headers: { "x-cron-secret": secret },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // A transport error may contain request headers; never print it.
    throw new Error("Scheduler health request failed or redirected. Check production availability and APP_URL.");
  }
  if (!response.ok) {
    throw new Error(`Scheduler health returned HTTP ${response.status}. Check production access before running a sweep.`);
  }

  let report;
  try {
    report = await response.json();
  } catch {
    throw new Error("Scheduler health did not return JSON. Check APP_URL and deployment protection.");
  }
  // Unauthenticated health deliberately returns HTTP 200 / { ok: true }.
  // Only the protected report proves the scheduler's secret was accepted.
  if (report?.cron?.secret !== true) {
    throw new Error("Scheduler authentication failed. Synchronize GitHub CRON_SECRET with Vercel Production, redeploy, then retry.");
  }
  if (
    report?.deploy?.environment !== "production" ||
    report?.supabase?.projectUrl !== PRODUCTION_DATABASE ||
    report?.supabase?.demoMode !== false
  ) {
    throw new Error("Scheduler target is not the production database. Check deployment environment and Supabase configuration.");
  }
  if (
    report?.supabase?.configured !== true ||
    report?.supabase?.serviceRoleKey !== true ||
    report?.database?.reachable !== true
  ) {
    throw new Error("Production database is unavailable or incompletely configured. Sweep was not started.");
  }
  if (requirements.dispatchRead && report?.database?.jobReadReady !== true) {
    throw new Error("Production dispatch job reads are not ready. Verify the deployed query and database migrations before running dispatch. Sweep was not started.");
  }
}
