import type { Frequency } from "../pricing/price-book";
import { mapCustomer, mapJob, streetMatchKey, type MappedCustomer, type MappedJob, type RoomCounts } from "./hcp.ts";
import { CustomerLinker, type KnownProperty, type LinkRule, type PropertySource } from "./link.ts";
import { buildPlans, parsePlanOverrides, type PlanGap, type PlanOverride, type PlannedPlan } from "./plans.ts";
import { formatTally, maskName, Tally } from "./report.ts";
import type { CalendarDate } from "../time/zone.ts";

/**
 * The whole import, decided before anything is written.
 *
 * Both files (and the optional plans file) are read, mapped, joined and turned
 * into plans here, in memory and without a database. The script then either
 * prints the report and stops (`--dry-run`) or writes exactly what this
 * returned. One code path decides; the dry run cannot disagree with the real
 * run about which job goes to which customer.
 */

export interface PlannedProperty extends KnownProperty {
  /** From the most recent job at this property whose description states them. */
  rooms: RoomCounts | null;
}

export interface PlannedJob {
  job: MappedJob;
  customerHcpId: string;
  propertyKey: string;
  rule: LinkRule;
  propertySource: PropertySource;
  /** The job's own frequency, or its plan's when it belongs to one. */
  freq: Frequency;
  planId: string | null;
}

export interface ImportPlan {
  customers: MappedCustomer[];
  properties: PlannedProperty[];
  jobs: PlannedJob[];
  plans: PlannedPlan[];
  report: ImportReport;
}

export interface ImportReport {
  customerRows: number;
  customersMapped: number;
  customersWithoutAddress: number;
  customersWithSeveralAddresses: number;
  customerProperties: number;
  jobRows: number;
  jobsLinked: number;
  linkedBy: Record<LinkRule, number>;
  propertySource: Record<PropertySource, number>;
  propertiesFromJobs: number;
  planRows: number;
  plansBySource: Record<"override" | "inferred", number>;
  plansByFreq: Partial<Record<Frequency, number>>;
  plansActive: number;
  gaps: (PlanGap & { name: string })[];
  /** Every plan to be written, with a masked name, for checking before the audit. */
  planSummaries: (Pick<PlannedPlan, "freq" | "agreedPriceCents" | "anchorDate" | "active" | "source" | "jobCount"> & {
    name: string;
    street: string;
  })[];
  /** Email addresses on more than one customer — jobs using them cannot link by email. */
  sharedEmails: number;
  /** Rows that were not imported, by reason. */
  skipped: Tally;
  /** Rows that were imported but a person should look at. */
  notices: Tally;
}

export interface PrepareInput {
  customers: readonly Record<string, string>[];
  jobs: readonly Record<string, string>[];
  plans?: readonly Record<string, string>[];
  today: CalendarDate;
}

function customerName(c: MappedCustomer | undefined): string {
  if (!c) return "(unknown)";
  return maskName(c.displayName ?? [c.firstName, c.lastName].filter(Boolean).join(" "));
}

export function prepareImport(input: PrepareInput): ImportPlan {
  const skipped = new Tally();
  const notices = new Tally();

  // --- customers -----------------------------------------------------------
  const customers: MappedCustomer[] = [];
  input.customers.forEach((row, i) => {
    const mapped = mapCustomer(row);
    if (!mapped.ok) {
      skipped.add(`customer: ${mapped.reason}`, {
        ref: `customers row ${i + 1}`,
        name: maskName(row.display_name ?? row.first_name ?? null),
        raw: mapped.raw ?? "",
      });
      return;
    }
    customers.push(mapped.value);
  });

  const seen = new Map<string, number>();
  for (const c of customers) seen.set(c.hcpId, (seen.get(c.hcpId) ?? 0) + 1);

  for (const c of customers) {
    const ex = { ref: `customer ${c.hcpId}`, name: customerName(c), raw: "" };
    if (c.addresses.length === 0) notices.add("customer without an address (imported, no property)", ex);
    if (c.doNotService) notices.add("customer marked Do Not Service (noted on the customer)", ex);
    if (c.nameLooksLikePhone) notices.add("customer name looks like a phone number", ex);
    if (!c.email && !c.phone) notices.add("customer with no email and no phone", ex);
    if ((seen.get(c.hcpId) ?? 0) > 1) notices.add("customer id appears more than once (later row wins)", ex);
  }

  const linker = new CustomerLinker(customers);

  // --- jobs ------------------------------------------------------------------
  const linkedBy: Record<LinkRule, number> = { customer_id: 0, email: 0, mobile: 0, name: 0 };
  const propertySource: Record<PropertySource, number> = { customer: 0, job: 0, primary: 0 };
  const linked: Omit<PlannedJob, "freq" | "planId">[] = [];

  input.jobs.forEach((row, i) => {
    const mapped = mapJob(row);
    if (!mapped.ok) {
      skipped.add(`job: ${mapped.reason}`, {
        ref: row.job ? `job ${row.job}` : `jobs row ${i + 1}`,
        name: maskName(row.customer_name ?? null),
        raw: mapped.raw ?? "",
      });
      return;
    }
    const job = mapped.value;
    const ex = { ref: `job ${job.hcpId}`, name: maskName(job.customerRef.name), raw: "" };

    const result = linker.link(job);
    if (!result.ok) {
      const ref = job.customerRef;
      skipped.add(`job: ${result.reason}`, {
        ...ex,
        raw:
          result.reason === "job address has no ZIP"
            ? (job.address?.street ?? "")
            : [ref.email, ref.mobileDigits].filter(Boolean).join(" / "),
      });
      return;
    }

    linkedBy[result.rule] += 1;
    propertySource[result.propertySource] += 1;
    linked.push({
      job,
      customerHcpId: result.customerHcpId,
      propertyKey: result.property.hcpAddressId,
      rule: result.rule,
      propertySource: result.propertySource,
    });

    if (job.serviceDefaulted) notices.add('job service not recognised (imported as "standard")', { ...ex, raw: job.serviceRaw ?? "" });
    if (job.priceCents === 0) notices.add(`$0 job, ${job.statusRaw ?? job.status}`, ex);
    if (!job.address) notices.add("job with no street (placed at the customer's primary address)", ex);
    if (job.status === "scheduled" && job.scheduledDate && job.scheduledDate < input.today) {
      notices.add("Scheduled or In progress job dated in the past (imported as it is)", {
        ...ex,
        raw: `${job.statusRaw ?? "Scheduled"} ${job.scheduledDate}`,
      });
    }
    if (!job.scheduledDate) notices.add("job with no scheduled date", ex);
  });

  // --- plans -----------------------------------------------------------------
  const { overrides, problems } = parsePlanOverrides(input.plans ?? []);
  for (const p of problems) skipped.add(p.reason, { ref: `plans row ${p.row}`, name: "", raw: p.raw });

  const resolved = new Map<string, PlanOverride & { customerHcpId: string }>();
  for (const override of overrides) {
    const ref = `plans row ${override.row}`;
    const who = linker.findByContact(override.customerContact);
    if (!who.ok) {
      skipped.add(`plan override: ${who.reason}`, { ref, name: "", raw: override.customerContact });
      continue;
    }
    const known = linker.properties.get(who.hcpId) ?? [];
    const name = customerName(linker.customers.get(who.hcpId));
    let property: KnownProperty | undefined;
    if (override.street) {
      property = known.find((p) => p.matchKey === streetMatchKey(override.street!));
      if (!property) {
        skipped.add("plan override: street is not one of the customer's addresses", { ref, name, raw: override.street });
        continue;
      }
    } else if (known.length === 1) {
      property = known[0];
    } else {
      skipped.add(`plan override: street needed (customer has ${known.length} addresses)`, { ref, name, raw: "" });
      continue;
    }
    if (resolved.has(property!.hcpAddressId)) {
      skipped.add("plan override: second row for the same address (first row kept)", { ref, name, raw: "" });
      continue;
    }
    resolved.set(property!.hcpAddressId, { ...override, customerHcpId: who.hcpId });
  }

  const { plans, gaps } = buildPlans(linked, resolved, input.today);

  const planByJob = new Map<string, PlannedPlan>();
  for (const plan of plans) for (const id of plan.jobHcpIds) planByJob.set(id, plan);

  const jobs: PlannedJob[] = linked.map((entry) => {
    const plan = planByJob.get(entry.job.hcpId);
    return { ...entry, freq: plan?.freq ?? entry.job.frequency, planId: plan?.hcpPlanId ?? null };
  });

  // --- properties ------------------------------------------------------------
  // Every customer address, plus every address a job added. Room counts from
  // the most recent job at that property whose description states them.
  const rooms = new Map<string, { date: string; rooms: RoomCounts }>();
  for (const { job, propertyKey } of jobs) {
    if (!job.rooms) continue;
    const date = job.scheduledStart ?? job.completedAt ?? "";
    const current = rooms.get(propertyKey);
    if (!current || date >= current.date) rooms.set(propertyKey, { date, rooms: job.rooms });
  }

  const properties: PlannedProperty[] = [];
  for (const list of linker.properties.values()) {
    for (const p of list) properties.push({ ...p, rooms: rooms.get(p.hcpAddressId)?.rooms ?? null });
  }

  const plansByFreq: Partial<Record<Frequency, number>> = {};
  for (const p of plans) plansByFreq[p.freq] = (plansByFreq[p.freq] ?? 0) + 1;

  return {
    customers,
    properties,
    jobs,
    plans,
    report: {
      customerRows: input.customers.length,
      customersMapped: customers.length,
      customersWithoutAddress: customers.filter((c) => c.addresses.length === 0).length,
      customersWithSeveralAddresses: customers.filter((c) => c.addresses.length > 1).length,
      customerProperties: customers.reduce((n, c) => n + c.addresses.length, 0),
      jobRows: input.jobs.length,
      jobsLinked: jobs.length,
      linkedBy,
      propertySource,
      propertiesFromJobs: properties.filter((p) => p.origin === "job").length,
      planRows: (input.plans ?? []).length,
      plansBySource: {
        override: plans.filter((p) => p.source === "override").length,
        inferred: plans.filter((p) => p.source === "inferred").length,
      },
      plansByFreq,
      plansActive: plans.filter((p) => p.active).length,
      gaps: gaps.map((g) => ({ ...g, name: customerName(linker.customers.get(g.customerHcpId)) })),
      planSummaries: plans.map((p) => ({
        name: customerName(linker.customers.get(p.customerHcpId)),
        street: properties.find((x) => x.hcpAddressId === p.propertyKey)?.street ?? "",
        freq: p.freq,
        agreedPriceCents: p.agreedPriceCents,
        anchorDate: p.anchorDate,
        active: p.active,
        source: p.source,
        jobCount: p.jobCount,
      })),
      sharedEmails: linker.sharedEmails(),
      skipped,
      notices,
    },
  };
}

/** The dry run's output. Also printed before a real run writes anything. */
export function formatReport(report: ImportReport): string {
  const r = report;
  const lines: string[] = [];

  lines.push(
    `customers: ${r.customerRows} rows · ${r.customersMapped} mapped · ${r.customerRows - r.customersMapped} skipped`,
    `  addresses: ${r.customerProperties} properties · ${r.customersMapped - r.customersWithoutAddress} customers with one or more · ` +
      `${r.customersWithoutAddress} customers without an address · ${r.customersWithSeveralAddresses} with more than one`,
  );
  lines.push(`  email addresses shared by more than one customer: ${r.sharedEmails}`);

  const skippedJobs = r.jobRows - r.jobsLinked;
  lines.push(
    "",
    `jobs: ${r.jobRows} rows · ${r.jobsLinked} linked · ${skippedJobs} skipped`,
    `  linked by: email ${r.linkedBy.email} · mobile ${r.linkedBy.mobile} · name ${r.linkedBy.name}` +
      (r.linkedBy.customer_id ? ` · customer id ${r.linkedBy.customer_id}` : ""),
    `  property: customer's address ${r.propertySource.customer} · address from the job ${r.propertySource.job} · ` +
      `customer's primary (job had no street) ${r.propertySource.primary}`,
    `  new properties created from job addresses: ${r.propertiesFromJobs}`,
  );

  const freq = Object.entries(r.plansByFreq)
    .map(([f, n]) => `${f} ${n}`)
    .join(" · ");
  const total = r.plansBySource.inferred + r.plansBySource.override;
  lines.push(
    "",
    `recurring plans: ${total} · ${r.plansBySource.inferred} from visit spacing · ${r.plansBySource.override} from the plans file` +
      (r.planRows ? ` (${r.planRows} rows)` : ""),
    `  ${freq || "none"} · ${r.plansActive} active`,
  );
  for (const p of r.planSummaries) {
    lines.push(
      `    ${p.name} · ${p.street} · ${p.freq} at $${(p.agreedPriceCents / 100).toFixed(2)} · ` +
        `from ${p.anchorDate} · ${p.active ? "active" : "inactive"} · ${p.source === "override" ? "plans file" : `${p.jobCount} visits`}`,
    );
  }
  const needs = r.gaps.filter((g) => g.reason === "needs frequency");
  if (needs.length) {
    lines.push(`  needs frequency (${needs.length}) — add a row to --plans for each:`);
    for (const g of needs) {
      lines.push(
        `    ${g.name}, ${g.jobCount} jobs, median gap ${g.medianGapDays === null ? "—" : `${g.medianGapDays} days`}`,
      );
    }
  }
  for (const reason of ["no price", "no anchor date"] as const) {
    const list = r.gaps.filter((g) => g.reason === reason);
    if (!list.length) continue;
    lines.push(`  ${reason} (${list.length}):`);
    for (const g of list) lines.push(`    ${g.name}, ${g.jobCount} jobs`);
  }
  if (r.plansActive > 0) {
    lines.push(
      `  NOTE: active plans are picked up by the daily recurring generator. Imported`,
      `  future visits are linked to their plan, so a visit on the plan's own cadence`,
      `  is not generated twice — but a visit HCP moved off-cadence, or one past HCP's`,
      `  last scheduled date, will be. Decide before the parallel run (active=false in`,
      `  --plans, or pause generation).`,
    );
  }

  const skippedLines = formatTally("not imported, by reason", r.skipped);
  const noticeLines = formatTally("imported, worth a look", r.notices);
  if (skippedLines.length) lines.push("", ...skippedLines);
  if (noticeLines.length) lines.push("", ...noticeLines);

  return lines.join("\n");
}
