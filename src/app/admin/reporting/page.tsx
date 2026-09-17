import { PageHeader, Pill, Stat } from "@/components/ui";
import { getRepository } from "@/lib/data";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoMode } from "@/lib/supabase/env";
import { formatCents, formatPct } from "@/lib/money";
import { formatDateInZone } from "@/lib/time/zone";

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

export const metadata = { title: "Reporting — Spotless Ops" };

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
  const [margins, risks] = await Promise.all([loadMargins(db), loadRisk(db)]);

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

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Revenue" value={formatCents(revenue)} note={`${completed.length} completed cleans`} />
        <Stat label="Labour + mileage" value={formatCents(cost)} />
        <Stat
          label="Margin"
          value={formatCents(margin)}
          note={revenue > 0 ? formatPct(margin / revenue, 1) : undefined}
          tone={margin > 0 ? "good" : "bad"}
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
            No completed cleans with a clock-in yet. Costing needs a real time entry — until a
            cleaner clocks in and out, the only labour number available is the estimate.
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
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
                {completed.slice(0, 50).map((row) => (
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
                    <Td>{row.service}</Td>
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

      <section>
        <p className="eyebrow mb-2">At risk</p>
        <p className="mb-3 max-w-2xl text-sm text-ink-2">
          Nobody cancels a cleaning service. They skip one, then another, and six weeks later
          they have somebody else. These are recurring customers past one and a half times their
          agreed cadence with nothing on the calendar.
        </p>

        {risks.length === 0 ? (
          <div className="card p-8 text-center text-sm text-ink-3">
            Nobody is overdue. This will stay empty until there are recurring plans with
            completed visits behind them.
          </div>
        ) : (
          <ul className="space-y-2">
            {risks.map((row) => (
              <li key={row.customerId} className="card flex items-center justify-between gap-4 p-4">
                <div>
                  <p className="font-medium text-ink">{row.name}</p>
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
