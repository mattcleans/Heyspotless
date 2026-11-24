import Link from "next/link";
import { SERVICE_LABELS, type ServiceType } from "@/lib/pricing/price-book";
import { PageHeader, Pill, Stat } from "@/components/ui";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoMode } from "@/lib/supabase/env";
import { formatCents, formatPct } from "@/lib/money";
import { formatDateInZone } from "@/lib/time/zone";
import { CLEANER_SHARE_OF_TICKET } from "@/lib/pricing/payout";

/**
 * What a clean actually earned, and who has quietly stopped booking.
 *
 * THE THING HOUSECALL PRO DOES NOT DO. Job costing per JOB — revenue minus the
 * labour that was really spent minus the driving — is the number the entire
 * dispatch argument in the build plan rests on, and until `0023` it existed
 * only in the plan's own tables.
 *
 * WHY THIS PAGE USES THE SERVICE ROLE. `job_costing` is a view, and a view in
 * Postgres runs with its owner's privileges: row-level security on `jobs` does
 * not protect it. Granting it to `authenticated` would let any signed-in
 * cleaner read every cleaner's pay and every customer's margin. So the grant
 * stops at the service role, and the admin check is made here, explicitly,
 * before anything is read.
 *
 * It is the one place in the app where that inversion is correct, and it is
 * worth being uncomfortable about: middleware already keeps non-admins out of
 * `/admin`, and this check is the belt to that braces.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Reporting | Hey Spotless management" };

interface MarginRow {
  jobId: string;
  completedAt: Date | null;
  service: string;
  cleanerName: string | null;
  cleanerType: string | null;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginFraction: number | null;
  minutesOverEstimate: number | null;
}

interface RiskRow {
  customerId: string;
  name: string;
  lastCompletedAt: Date | null;
  daysSinceLast: number | null;
  expectedDays: number | null;
  cadencesMissed: number | null;
  lifetimeValueCents: number;
}

export default async function ReportingPage() {
  const repo = await getRepository();
  const profile = await repo.getCurrentProfile();

  if (isDemoMode()) {
    return (
      <>
        <PageHeader eyebrow="Admin" title="Reporting">
          Job costing and churn risk.
        </PageHeader>
        <div className="card p-8 text-center text-sm text-ink-3">
          Costing is computed from real clock-ins and real payouts, so there is nothing honest to
          show from fixtures.
        </div>
      </>
    );
  }

  if (!profile || profile.role !== "admin") {
    return (
      <>
        <PageHeader eyebrow="Admin" title="Reporting">
          Job costing and churn risk.
        </PageHeader>
        <div className="card p-8 text-center text-sm text-ink-3">
          This page shows every cleaner&apos;s pay and every customer&apos;s margin. Admins only.
        </div>
      </>
    );
  }

  const db = createAdminClient();
  const [margins, risks, oversight, escalated] = await Promise.all([
    loadMargins(db),
    loadRisk(db),
    loadOversight(db),
    loadEscalatedPairings(db),
  ]);

  const completed = margins.filter((m) => m.completedAt !== null);
  const revenue = completed.reduce((sum, m) => sum + m.revenueCents, 0);
  const cost = completed.reduce((sum, m) => sum + m.costCents, 0);
  const margin = revenue - cost;

  const overruns = completed.filter(
    (m) => m.minutesOverEstimate !== null && m.minutesOverEstimate > 0,
  );

  return (
    <>
      <PageHeader eyebrow="Admin" title="Reporting">
        Revenue minus the labour that was actually spent, per job. Overtime is deliberately
        absent — it is a property of the week, not of a job, and it belongs on the dispatch
        board where the week is visible.
      </PageHeader>

      <p className="mb-4 text-sm text-ink-2">Totals cover completed visits within the latest 200 costing records, ordered by finish date. They exclude overhead and weekly overtime. Dates use Dallas time.</p>

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Revenue" value={formatCents(revenue)} note={`${completed.length} completed cleans`} />
        <Stat label="Labour + mileage" value={formatCents(cost)} />
        <Stat
          label="Margin"
          value={formatCents(margin)}
          note={revenue > 0 ? formatPct(margin / revenue, 1) : undefined}
          tone={margin > 0 ? "good" : margin < 0 ? "bad" : "default"}
        />
        <Stat
          label="Over estimate"
          value={`${overruns.length}`}
          note="Cleans that ran longer than quoted. Persistently high means we under-quote time."
          tone={overruns.length > completed.length / 3 ? "warn" : "default"}
        />
      </div>

      <section className="mb-8">
        <p className="eyebrow mb-2">Recent cleans</p>
        {completed.length === 0 ? (
          <div className="card p-8 text-center text-sm text-ink-3">
            No completed visits in the latest costing records. Actual labour costs become available as cleaners record their time.
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Completed visit costing from the latest 200 records. Dates use Dallas time.</caption>
              <thead>
                <tr className="border-b border-line text-left">
                  <Th>Finished</Th>
                  <Th>Cleaner</Th>
                  <Th>Service</Th>
                  <Th right>Ticket</Th>
                  <Th right>Cost</Th>
                  <Th right>Margin</Th>
                  <Th right>vs estimate</Th>
                </tr>
              </thead>
              <tbody>
                {completed.map((row) => (
                  <tr key={row.jobId} className="border-b border-line last:border-0">
                    <Td>{row.completedAt ? formatDateInZone(row.completedAt) : "—"}</Td>
                    <Td>
                      {row.cleanerName ?? "Unassigned"}
                      {row.cleanerType === "contractor_1099" ? (
                        <Pill>1099</Pill>
                      ) : row.cleanerType ? (
                        <Pill tone="sky">W-2</Pill>
                      ) : null}
                    </Td>
                    <Td>{SERVICE_LABELS[row.service as ServiceType] ?? row.service}</Td>
                    <Td right>{formatCents(row.revenueCents)}</Td>
                    <Td right>{formatCents(row.costCents)}</Td>
                    <Td right>
                      <span className={row.marginCents >= 0 ? "text-good" : "text-bad"}>
                        {formatCents(row.marginCents)}
                        {row.marginFraction !== null ? (
                          <span className="ml-1 text-xs text-ink-3">
                            {formatPct(row.marginFraction, 0)}
                          </span>
                        ) : null}
                      </span>
                    </Td>
                    <Td right>
                      {row.minutesOverEstimate === null
                        ? "—"
                        : `${row.minutesOverEstimate > 0 ? "+" : ""}${row.minutesOverEstimate}m`}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-8">
        <p className="eyebrow mb-2">Dispatch oversight · last 30 days</p>
        <p className="mb-3 max-w-2xl text-sm text-ink-2">
          The north-star here is <strong>manager interventions per 100 completed cleans</strong>:
          how often a person had to decide what the engine should have. Escalated pairings are
          relationships where the same cleaner keeps accepting the same customer only above the
          standard {formatPct(CLEANER_SHARE_OF_TICKET, 0)} share — a share below market for that
          home, to re-agree deliberately rather than re-escalate weekly.
        </p>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Stat
            label="Interventions / 100 cleans"
            value={
              oversight.completedCleans === 0
                ? "—"
                : ((oversight.interventions / oversight.completedCleans) * 100).toFixed(1)
            }
            note={`${oversight.interventions} interventions · ${oversight.completedCleans} completed cleans`}
            tone={
              oversight.completedCleans > 0 &&
              oversight.interventions / oversight.completedCleans > 0.2
                ? "warn"
                : "default"
            }
          />
          <Stat
            label="Engine decisions"
            value={`${oversight.engineDecisions}`}
            note="Dispatch decisions the engine made alone."
          />
          <Stat
            label="Escalated pairings"
            value={`${escalated.length}`}
            note="Cleaner–customer pairs with 2+ accepted offers above the standard share."
            tone={escalated.length > 0 ? "warn" : "default"}
          />
        </div>
        {escalated.length > 0 ? (
          <ul className="space-y-2">
            {escalated.map((row) => (
              <li
                key={`${row.cleanerId}:${row.customerId}`}
                className="card flex flex-wrap items-center justify-between gap-4 p-4"
              >
                <div>
                  <span className="font-medium">{row.cleanerName}</span>
                  <span className="text-ink-3"> cleaning for </span>
                  <Link
                    href={`/admin/customers/${row.customerId}`}
                    className="font-medium text-navy underline"
                  >
                    {row.customerName}
                  </Link>
                  <p className="mt-0.5 text-sm text-ink-3">
                    {row.acceptedAboveShare} accepted above share · latest{" "}
                    {row.latestAcceptedAt ? formatDateInZone(row.latestAcceptedAt) : "—"}
                  </p>
                </div>
                <Pill tone="warn">up to {formatPct(row.maxPct, 0)}</Pill>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section>
        <p className="eyebrow mb-2">At risk</p>
        <p className="mb-3 max-w-2xl text-sm text-ink-2">
          Recurring customers past one and a half times their agreed cadence with nothing on the calendar. Showing up to 50 customers, longest overdue first. Open a customer record to review their plan and arrange a follow-up.
        </p>

        {risks.length === 0 ? (
          <div className="card p-8 text-center text-sm text-ink-3">
            No recurring customers meet the overdue criteria. This check requires an active recurring plan and a completed visit.
          </div>
        ) : (
          <ul className="space-y-2">
            {risks.map((row) => (
              <li key={row.customerId} className="card flex flex-wrap items-center justify-between gap-4 p-4">
                <div>
                  <Link href={`/admin/customers/${row.customerId}`} className="font-medium text-navy underline">{row.name}</Link>
                  <p className="mt-0.5 text-sm text-ink-3">
                    Last clean{" "}
                    {row.lastCompletedAt ? formatDateInZone(row.lastCompletedAt) : "never"} ·
                    expects one every {row.expectedDays} days
                  </p>
                </div>
                <div className="text-right">
                  <Pill tone="bad">{row.daysSinceLast} days</Pill>
                  <p className="mt-1 text-xs text-ink-3">
                    {row.cadencesMissed !== null ? `${row.cadencesMissed}× cadence` : ""} ·{" "}
                    {formatCents(row.lifetimeValueCents)} lifetime
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-3 py-2 text-xs font-medium text-ink-3 ${right ? "text-right" : ""}`}>
      {children}
    </th>
  );
}

function Td({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return <td className={`px-3 py-2 ${right ? "nums text-right" : ""}`}>{children}</td>;
}

interface OversightStats {
  interventions: number;
  engineDecisions: number;
  completedCleans: number;
}

interface EscalatedPairing {
  cleanerId: string;
  customerId: string;
  cleanerName: string;
  customerName: string;
  acceptedAboveShare: number;
  maxPct: number;
  latestAcceptedAt: Date | null;
}

const OVERSIGHT_WINDOW_DAYS = 30;

function oversightSince(): string {
  return new Date(Date.now() - OVERSIGHT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The numerator is dispatch_decisions.decided_by — null means the engine
 * decided, set means a person did. The column has been populated since the
 * first decision recorded precisely so this metric could exist; this is the
 * first place that reads it.
 */
async function loadOversight(db: ReturnType<typeof createAdminClient>): Promise<OversightStats> {
  const since = oversightSince();

  const [interventions, engine, completed] = await Promise.all([
    db
      .from("dispatch_decisions")
      .select("id", { count: "exact", head: true })
      .not("decided_by", "is", null)
      .gte("decided_at", since),
    db
      .from("dispatch_decisions")
      .select("id", { count: "exact", head: true })
      .is("decided_by", null)
      .gte("decided_at", since),
    db
      .from("jobs")
      .select("id", { count: "exact", head: true })
      // job_status spells it `complete`; `completed` is rejected outright.
      .eq("status", "complete")
      .gte("completed_at", since),
  ]);

  for (const r of [interventions, engine, completed]) {
    if (r.error) throw new Error(`dispatch oversight: ${r.error.message}`);
  }

  return {
    interventions: interventions.count ?? 0,
    engineDecisions: engine.count ?? 0,
    completedCleans: completed.count ?? 0,
  };
}

/**
 * An escalated rung is a one-off for that visit; the standard share stands
 * next time. A pairing that keeps accepting only above the standard share is
 * one whose share is below market for that customer — it should be re-agreed
 * by a person (agreed_payout_share exists for exactly that) rather than
 * re-escalated every week. The data has been in offers.payout_pct all along;
 * this surfaces it.
 */
async function loadEscalatedPairings(
  db: ReturnType<typeof createAdminClient>,
): Promise<EscalatedPairing[]> {
  // Strictly above the standard share, with a small tolerance for the
  // numeric(6,5) column so 0.33000 itself never counts as escalated.
  const threshold = CLEANER_SHARE_OF_TICKET + 0.005;

  const { data, error } = await db
    .from("offers")
    .select(
      "cleaner_id, payout_pct, responded_at, " +
        // Cleaners carry one full_name, not first and last names.
        "cleaners(full_name), " +
        "jobs(customer_id, customers(first_name, last_name))",
    )
    .eq("status", "accepted")
    .gt("payout_pct", threshold)
    .gte("responded_at", oversightSince())
    .order("responded_at", { ascending: false })
    .limit(500);

  if (error) throw new Error(`escalated pairings: ${error.message}`);

  const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];
  const pairs = new Map<string, EscalatedPairing>();

  for (const row of rows) {
    const cleanerId = String(row["cleaner_id"]);
    const job = row["jobs"] as Record<string, unknown> | null;
    if (!job) continue;
    const customerId = String(job["customer_id"]);
    const key = `${cleanerId}:${customerId}`;
    const pct = Number(row["payout_pct"] ?? 0);
    const at = row["responded_at"] ? new Date(String(row["responded_at"])) : null;

    const existing = pairs.get(key);
    if (existing) {
      existing.acceptedAboveShare += 1;
      existing.maxPct = Math.max(existing.maxPct, pct);
      if (at && (!existing.latestAcceptedAt || at > existing.latestAcceptedAt)) {
        existing.latestAcceptedAt = at;
      }
      continue;
    }

    const cleaner = row["cleaners"] as Record<string, unknown> | null;
    const customer = (job["customers"] ?? null) as Record<string, unknown> | null;
    pairs.set(key, {
      cleanerId,
      customerId,
      cleanerName: typeof cleaner?.["full_name"] === "string" && cleaner["full_name"] ? cleaner["full_name"] : "Cleaner",
      customerName: personName(customer, "Customer"),
      acceptedAboveShare: 1,
      maxPct: pct,
      latestAcceptedAt: at,
    });
  }

  return [...pairs.values()]
    .filter((p) => p.acceptedAboveShare >= 2)
    .sort((a, b) => b.acceptedAboveShare - a.acceptedAboveShare)
    .slice(0, 20);
}

function personName(row: Record<string, unknown> | null, fallback: string): string {
  if (!row) return fallback;
  return (
    [row["first_name"], row["last_name"]]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join(" ") || fallback
  );
}

async function loadMargins(db: ReturnType<typeof createAdminClient>): Promise<MarginRow[]> {
  const { data, error } = await db
    .from("job_margins")
    .select(
      "job_id, completed_at, service, cleaner_name, cleaner_type, revenue_cents, " +
        "cost_cents, margin_cents, margin_fraction, minutes_over_estimate",
    )
    .order("completed_at", { ascending: false, nullsFirst: false })
    .limit(200);

  if (error) throw new Error(`job_margins: ${error.message}`);

  const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];

  return rows.map((row) => ({
    jobId: String(row["job_id"]),
    completedAt: row["completed_at"] ? new Date(String(row["completed_at"])) : null,
    service: typeof row["service"] === "string" ? row["service"] : "clean",
    cleanerName: typeof row["cleaner_name"] === "string" ? row["cleaner_name"] : null,
    cleanerType: typeof row["cleaner_type"] === "string" ? row["cleaner_type"] : null,
    revenueCents: Number(row["revenue_cents"] ?? 0),
    costCents: Number(row["cost_cents"] ?? 0),
    marginCents: Number(row["margin_cents"] ?? 0),
    marginFraction: row["margin_fraction"] === null ? null : Number(row["margin_fraction"]),
    minutesOverEstimate:
      row["minutes_over_estimate"] === null ? null : Number(row["minutes_over_estimate"]),
  }));
}

async function loadRisk(db: ReturnType<typeof createAdminClient>): Promise<RiskRow[]> {
  const { data, error } = await db
    .from("customer_at_risk")
    .select(
      "customer_id, first_name, last_name, last_completed_at, days_since_last, " +
        "expected_days, cadences_missed, lifetime_value_cents",
    )
    .eq("at_risk", true)
    .order("days_since_last", { ascending: false })
    .limit(50);

  if (error) throw new Error(`customer_at_risk: ${error.message}`);

  const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];

  return rows.map((row) => ({
    customerId: String(row["customer_id"]),
    name:
      [row["first_name"], row["last_name"]]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .join(" ") || "Customer",
    lastCompletedAt: row["last_completed_at"] ? new Date(String(row["last_completed_at"])) : null,
    daysSinceLast: row["days_since_last"] === null ? null : Number(row["days_since_last"]),
    expectedDays: row["expected_days"] === null ? null : Number(row["expected_days"]),
    cadencesMissed: row["cadences_missed"] === null ? null : Number(row["cadences_missed"]),
    lifetimeValueCents: Number(row["lifetime_value_cents"] ?? 0),
  }));
}
