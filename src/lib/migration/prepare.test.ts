import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCsv, toRecords } from "./csv";
import { formatReport, prepareImport } from "./prepare";
import type { CalendarDate } from "../time/zone";

/**
 * The whole mapper, over a fixture pair with the real export's headings and
 * made-up people. `customers.csv` has all 58 columns of the 2026 customer
 * export; `jobs.csv` has the 24 of its 66 that the importer reads.
 *
 * The first dry run against the real files skipped all 1,781 jobs for "no job
 * id". The assertion that matters most here is that nothing is skipped for a
 * reason that means "the importer cannot read this export".
 */

function fixture(name: string): Record<string, string>[] {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return toRecords(parseCsv(readFileSync(path, "utf8")));
}

const TODAY = "2026-09-28" as CalendarDate;

function run(plans: Record<string, string>[] = []) {
  return prepareImport({ customers: fixture("customers.csv"), jobs: fixture("jobs.csv"), plans, today: TODAY });
}

describe("the fixture export", () => {
  it("has the real headings", () => {
    expect(Object.keys(fixture("customers.csv")[0]!)).toHaveLength(58);
    expect(Object.keys(fixture("jobs.csv")[0]!)).toContain("job");
  });

  it("skips no job for being unreadable, and none for a missing customer id", () => {
    const { report } = run();
    const reasons = report.skipped.list().map((s) => s.reason);
    for (const unreadable of ["no job id", "no customer id", "no customer reference", "no readable price"]) {
      expect(reasons.some((r) => r.includes(unreadable))).toBe(false);
    }
  });

  it("reads every customer, with every address", () => {
    const { customers, report } = run();
    expect(customers).toHaveLength(11);
    expect(report.customersMapped).toBe(11);
    expect(report.customerProperties).toBe(11);
    expect(report.customersWithoutAddress).toBe(1);
    expect(report.customersWithSeveralAddresses).toBe(1);
  });

  it("links every job it can, and says by which rule", () => {
    const { report, jobs } = run();
    expect(report.jobRows).toBe(29);
    expect(report.jobsLinked).toBe(24);
    expect(jobs).toHaveLength(24);
    expect(report.linkedBy).toEqual({ customer_id: 0, email: 19, mobile: 2, name: 3 });
    expect(report.propertySource).toEqual({ customer: 22, job: 2, primary: 0 });
    expect(report.propertiesFromJobs).toBe(1);
  });

  it("strips the Excel wrapper from every job number, in both spellings", () => {
    const ids = run().jobs.map((j) => j.job.hcpId);
    expect(ids).toContain("10");
    expect(ids.every((id) => /^\d+$/.test(id))).toBe(true);
  });

  it("groups every skipped job by reason", () => {
    const counts = Object.fromEntries(run().report.skipped.list().map((s) => [s.reason, s.count]));
    expect(counts).toEqual({
      "job: ambiguous customer: email matched 2 customers": 1,
      "job: ambiguous customer: name matched 2 customers": 1,
      "job: job address has no ZIP": 1,
      "job: no address": 1,
      "job: no matching customer": 1,
    });
  });

  it("reports what was imported but wants a person", () => {
    const { notices } = run().report;
    expect(notices.count("$0 job, Completed")).toBe(1);
    expect(notices.count("customer marked Do Not Service (noted on the customer)")).toBe(1);
    expect(notices.count("customer name looks like a phone number")).toBe(1);
    expect(notices.count("Scheduled or In progress job dated in the past (imported as it is)")).toBe(2);
    expect(notices.count('job service not recognised (imported as "standard")')).toBe(1);
  });

  it("puts a property's room counts from its most recent job", () => {
    const dana = run().properties.find((p) => p.hcpAddressId === "131000006:600 birch ln");
    expect(dana?.rooms).toEqual({
      bedrooms: 3,
      bathrooms: 2,
      halfBaths: 1,
      kitchens: 1,
      utilityRooms: 0,
      livingRooms: 2,
    });
  });

  it("creates the property a job added once, with its normalised ZIP", () => {
    const created = run().properties.filter((p) => p.origin === "job");
    expect(created).toEqual([
      expect.objectContaining({ hcpAddressId: "131000005:520 cedar rd", zip: "76010", state: "TX" }),
    ]);
  });

  it("infers the plans the spacing supports, and lists the rest", () => {
    const { plans, report } = run();
    expect(plans.map((p) => [p.hcpPlanId, p.freq, p.agreedPriceCents, p.anchorDate, p.active])).toEqual([
      ["131000001:100 oak st:biweekly", "biweekly", 15400, "2026-10-12", true],
      ["131000007:700 maple dr:monthly", "monthly", 28500, "2026-09-14", false],
    ]);
    expect(report.gaps).toEqual([
      expect.objectContaining({ customerHcpId: "131000011", reason: "needs frequency", jobCount: 4, medianGapDays: 11 }),
    ]);
  });

  it("gives a plan's jobs the plan's frequency, and leaves one-offs alone", () => {
    const { jobs } = run();
    const freq = (id: string) => jobs.find((j) => j.job.hcpId === id)?.freq;
    expect(freq("10")).toBe("biweekly");
    expect(freq("30")).toBe("monthly");
    expect(freq("40")).toBe("one_time");
    // Kim's visits are recurring but have no plan, so no frequency is invented.
    expect(freq("50")).toBe("one_time");
  });

  it("lets the plans file decide a customer the spacing could not", () => {
    const { plans, report } = run([
      { customer_email_or_phone: "(214) 555-0111", street: "1100 Aspen Way", freq: "weekly", agreed_price: "$150.00" },
    ]);
    expect(report.gaps).toEqual([]);
    expect(plans.find((p) => p.customerHcpId === "131000011")).toMatchObject({
      freq: "weekly",
      source: "override",
      agreedPriceCents: 15000,
      // The 2 September visit is still In progress; the last completed one anchors it.
      anchorDate: "2026-08-22",
    });
  });

  it("reports a plans row it cannot place", () => {
    const { report } = run([
      { customer_email_or_phone: "family@example.com", freq: "weekly" },
      { customer_email_or_phone: "ops@northside.example", freq: "weekly" },
      { customer_email_or_phone: "paula@example.com", street: "1 Elsewhere", freq: "weekly" },
    ]);
    const reasons = report.skipped.list().map((s) => s.reason);
    expect(reasons).toContain("plan override: ambiguous customer: email matched 2 customers");
    expect(reasons).toContain("plan override: street needed (customer has 3 addresses)");
    expect(reasons).toContain("plan override: street is not one of the customer's addresses");
  });

  it("prints no full name, email or phone number", () => {
    const text = formatReport(run().report);
    for (const secret of ["Paula", "Marsh", "paula@example.com", "family@example.com", "214-555-0102", "(817) 555-0104", "2145550199"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("linked by: email 19 · mobile 2 · name 3");
    expect(text).toContain("K**** W****, 4 jobs, median gap 11 days");
  });
});
