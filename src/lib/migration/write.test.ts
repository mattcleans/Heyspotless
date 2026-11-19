import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCsv, toRecords } from "./csv";
import { prepareImport } from "./prepare";
import { writeImport, type WriteLog } from "./write";
import type { CalendarDate } from "../time/zone";

/**
 * What the import actually sends to the database, against a stand-in that
 * records every call. The fixture export, prepared exactly as the script
 * prepares it.
 */

const TODAY = "2026-09-28" as CalendarDate;

function fixture(name: string): Record<string, string>[] {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return toRecords(parseCsv(readFileSync(path, "utf8")));
}

function prepared(historyOnly: boolean) {
  return prepareImport({ customers: fixture("customers.csv"), jobs: fixture("jobs.csv"), plans: [], today: TODAY, historyOnly });
}

interface Update {
  table: string;
  values: Record<string, unknown>;
  filters: [string, string, unknown][];
}

function fakeDb(options: { failJob?: string; roomsMissing?: boolean; failBilling?: boolean } = {}) {
  const rpc: { name: string; args: Record<string, unknown> }[] = [];
  const updates: Update[] = [];
  let next = 0;
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      rpc.push({ name, args });
      if (name === "import_job" && args["p_hcp_id"] === options.failJob) {
        return { data: null, error: { message: "boom" } };
      }
      if (name === "import_property" && options.roomsMissing && "p_kitchens" in args) {
        return { data: null, error: { code: "PGRST202", message: "no such function" } };
      }
      next += 1;
      return { data: `${name}-${next}`, error: null };
    },
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          const update: Update = { table, values, filters: [] };
          updates.push(update);
          const chain = {
            eq(column: string, value: unknown) {
              update.filters.push(["eq", column, value]);
              return chain;
            },
            is(column: string, value: unknown) {
              update.filters.push(["is", column, value]);
              const billing = "invoiced_at" in values;
              return Promise.resolve({ error: billing && options.failBilling ? { message: "denied" } : null });
            },
          };
          return chain;
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, rpc, updates };
}

const quiet: WriteLog = { info() {}, warn() {}, error() {} };

describe("writing a history-only import", () => {
  it("writes every customer, property and finished job, and no plan", async () => {
    const plan = prepared(true);
    const { db, rpc } = fakeDb();
    const summary = await writeImport(db, plan, TODAY, quiet);

    expect(summary.failed).toBe(false);
    expect(rpc.filter((c) => c.name === "import_customer")).toHaveLength(plan.customers.length);
    expect(rpc.filter((c) => c.name === "import_property")).toHaveLength(plan.properties.length);
    const jobs = rpc.filter((c) => c.name === "import_job");
    expect(jobs).toHaveLength(plan.jobs.length);
    expect(jobs.every((c) => c.args["p_status"] !== "scheduled")).toBe(true);
    expect(rpc.some((c) => c.name === "import_recurring_plan")).toBe(false);
    expect(summary.plans).toEqual({ written: 0, failed: 0 });
  });

  it("passes each completed job's completion date", async () => {
    const plan = prepared(true);
    const { db, rpc } = fakeDb();
    await writeImport(db, plan, TODAY, quiet);

    const completed = plan.jobs.filter((j) => j.job.status === "complete");
    expect(completed.length).toBeGreaterThan(0);
    for (const j of completed) {
      const call = rpc.find((c) => c.name === "import_job" && c.args["p_hcp_id"] === j.job.hcpId);
      expect(call?.args["p_completed_at"]).toBe(j.job.completedAt);
      expect(j.job.completedAt).not.toBeNull();
    }
  });

  it("marks each completed job as billed in Housecall Pro, never overwriting", async () => {
    const plan = prepared(true);
    const { db, rpc, updates } = fakeDb();
    const summary = await writeImport(db, plan, TODAY, quiet);

    const completed = plan.jobs.filter((j) => j.job.status === "complete");
    const billing = updates.filter((u) => u.table === "jobs" && "invoiced_at" in u.values);
    expect(billing).toHaveLength(completed.length);
    expect(summary.billedElsewhere).toEqual({ written: completed.length, failed: 0 });
    // The stand-in returns ids in call order, so each import_job call's id is
    // recorded alongside it; every billing update must target one of them.
    const jobIdByHcp = new Map<unknown, unknown>();
    let n = 0;
    for (const c of rpc) {
      n += 1;
      if (c.name === "import_job") jobIdByHcp.set(c.args["p_hcp_id"], `import_job-${n}`);
    }
    for (const j of completed) {
      const id = jobIdByHcp.get(j.job.hcpId);
      const update = billing.find((u) => u.filters.some(([op, column, value]) => op === "eq" && column === "id" && value === id));
      expect(update, `job ${j.job.hcpId}`).toBeDefined();
      expect(update!.filters).toContainEqual(["is", "invoiced_at", null]);
      expect(update!.values["invoiced_at"]).toBe(j.job.completedAt);
    }
  });

  it("does not mark a job billed when the job itself failed to write", async () => {
    const plan = prepared(true);
    const victim = plan.jobs.find((j) => j.job.status === "complete")!.job.hcpId;
    const { db, updates } = fakeDb({ failJob: victim });
    const summary = await writeImport(db, plan, TODAY, quiet);

    expect(summary.failed).toBe(true);
    expect(summary.jobs.failed).toBe(1);
    expect(summary.billedElsewhere.written).toBe(plan.jobs.filter((j) => j.job.status === "complete").length - 1);
    expect(updates.filter((u) => "invoiced_at" in u.values)).toHaveLength(summary.billedElsewhere.written);
  });

  it("reports a failure to mark a job billed", async () => {
    const plan = prepared(true);
    const { db } = fakeDb({ failBilling: true });
    const summary = await writeImport(db, plan, TODAY, quiet);
    expect(summary.failed).toBe(true);
    expect(summary.billedElsewhere.failed).toBe(plan.jobs.filter((j) => j.job.status === "complete").length);
  });

  it("carries on without the extra room columns when migration 0029 is missing", async () => {
    const plan = prepared(true);
    const { db, rpc } = fakeDb({ roomsMissing: true });
    const warnings: string[] = [];
    const summary = await writeImport(db, plan, TODAY, { ...quiet, warn: (m) => warnings.push(m) });
    expect(summary.properties.failed).toBe(0);
    expect(warnings.some((w) => w.includes("migration 0029"))).toBe(true);
    const properties = rpc.filter((c) => c.name === "import_property");
    expect(properties.filter((c) => "p_kitchens" in c.args)).toHaveLength(1);
  });
});

describe("writing a full import", () => {
  it("writes the plans a history-only import leaves out", async () => {
    const plan = prepared(false);
    const { db, rpc } = fakeDb();
    const summary = await writeImport(db, plan, TODAY, quiet);
    expect(plan.plans.length).toBeGreaterThan(0);
    expect(rpc.filter((c) => c.name === "import_recurring_plan")).toHaveLength(plan.plans.length);
    expect(summary.plans.written).toBe(plan.plans.length);
  });
});
