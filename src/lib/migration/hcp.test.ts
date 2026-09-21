import { describe, expect, it } from "vitest";
import { parseCsv, toRecords } from "./csv";
import {
  customerKeys,
  hasUnsupportedCadence,
  mapCustomer,
  mapFrequency,
  mapJob,
  mapJobStatus,
  mapService,
  normalisePhone,
  parseExportDate,
  parseMoneyCents,
} from "./hcp";

/**
 * Every case here is a row that would otherwise be imported wrongly and
 * silently. A migration does not fail loudly; it bills somebody the wrong
 * amount every fortnight until they notice.
 */

describe("parseMoneyCents", () => {
  it("reads the formats an export actually writes", () => {
    expect(parseMoneyCents("$1,250.00")).toBe(125000);
    expect(parseMoneyCents("1250.00")).toBe(125000);
    expect(parseMoneyCents("1250")).toBe(125000);
    expect(parseMoneyCents("170.50")).toBe(17050);
  });

  /** parseFloat("$1,250.00") is NaN, and a NaN that becomes 0 is a free clean. */
  it("refuses rather than returning zero for something unreadable", () => {
    expect(parseMoneyCents("n/a")).toBeNull();
    expect(parseMoneyCents("")).toBeNull();
    expect(parseMoneyCents(null)).toBeNull();
    expect(parseMoneyCents("TBD")).toBeNull();
  });

  it("reads a parenthesised credit as negative", () => {
    expect(parseMoneyCents("(50.00)")).toBe(-5000);
  });

  it("does not lose a cent to floating point", () => {
    expect(parseMoneyCents("0.29")).toBe(29);
    expect(parseMoneyCents("362.70")).toBe(36270);
  });
});

describe("parseExportDate", () => {
  it("reads ISO", () => {
    expect(parseExportDate("2026-09-17 10:00")).toEqual({
      date: "2026-09-17",
      time: "10:00",
      offset: null,
    });
    expect(parseExportDate("2026-09-17")).toEqual({
      date: "2026-09-17",
      time: null,
      offset: null,
    });
  });

  it("reads the US format the dashboard exports", () => {
    expect(parseExportDate("9/17/2026 10:00 AM")).toEqual({
      date: "2026-09-17",
      time: "10:00",
      offset: null,
    });
  });

  /** The two everybody gets backwards. */
  it("gets noon and midnight right", () => {
    expect(parseExportDate("9/17/2026 12:00 PM")?.time).toBe("12:00");
    expect(parseExportDate("9/17/2026 12:30 AM")?.time).toBe("00:30");
  });

  it("converts afternoon times", () => {
    expect(parseExportDate("9/17/2026 2:15 PM")?.time).toBe("14:15");
  });

  it("is null for something that is not a date", () => {
    expect(parseExportDate("soon")).toBeNull();
    expect(parseExportDate(null)).toBeNull();
  });
});

describe("mapService", () => {
  /** "Deep Clean - Move Out" is a move-out. Checking "deep" first misprices it. */
  it("reads a move-out as a move-out even when it says deep", () => {
    expect(mapService("Deep Clean - Move Out")).toBe("move_in_out");
    expect(mapService("Move In Clean")).toBe("move_in_out");
  });

  it("reads the other two", () => {
    expect(mapService("Deep Clean")).toBe("deep");
    expect(mapService("Standard Clean")).toBe("standard");
    expect(mapService("Recurring maintenance clean")).toBe("standard");
  });

  it("is null for something unrecognised", () => {
    expect(mapService("Carpet shampoo")).toBeNull();
  });
});

describe("mapFrequency", () => {
  /**
   * THE ONE THAT MATTERS MOST. "Every other week" contains "week". Reading it
   * as weekly doubles that customer's visits and halves the price of each.
   */
  it("reads every-other-week as fortnightly, not weekly", () => {
    expect(mapFrequency("Every other week")).toBe("biweekly");
    expect(mapFrequency("Every 2 weeks")).toBe("biweekly");
    expect(mapFrequency("Bi-weekly")).toBe("biweekly");
  });

  it("reads monthly before it reads weekly", () => {
    expect(mapFrequency("Monthly")).toBe("monthly");
    expect(mapFrequency("Every 4 weeks, monthly billing")).toBe("monthly");
  });

  it("reads the plain cases", () => {
    expect(mapFrequency("Weekly")).toBe("weekly");
    expect(mapFrequency("One-time")).toBe("one_time");
  });

  /** "We assumed one-time" is not a defence for billing somebody wrongly. */
  it("refuses rather than guessing", () => {
    expect(mapFrequency("as needed")).toBeNull();
    expect(mapFrequency(null)).toBeNull();
  });
});

describe("mapJobStatus", () => {
  it("recognises finished and cancelled", () => {
    expect(mapJobStatus("Completed")).toBe("complete");
    expect(mapJobStatus("Paid")).toBe("complete");
    expect(mapJobStatus("Canceled")).toBe("canceled");
  });

  /**
   * The asymmetry is deliberate: a finished job imported as scheduled puts a
   * clean that already happened onto the dispatch board.
   */
  it("treats anything else as still to come", () => {
    expect(mapJobStatus("In Progress")).toBe("scheduled");
    expect(mapJobStatus(null)).toBe("scheduled");
  });
});

describe("mapCustomer", () => {
  it("maps a row with a person's name", () => {
    const mapped = mapCustomer({
      customer_id: "hcp-1",
      first_name: "Dana",
      last_name: "Reyes",
      mobile_number: "(214) 555-0143",
      street: "9 Reply Rd",
      city: "Plano",
      zip: "75024",
    });

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.firstName).toBe("Dana");
    expect(mapped.value.address?.zip).toBe("75024");
  });

  /** An agency managing a rental has no first name and is still a customer. */
  it("keeps a company with no personal name", () => {
    const mapped = mapCustomer({ customer_id: "hcp-2", company: "Northside Rentals" });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.firstName).toBe("Northside Rentals");
  });

  it("refuses a row with no id", () => {
    expect(mapCustomer({ first_name: "Dana" })).toEqual({ ok: false, problem: "no customer id" });
  });

  it("refuses a row with no name at all", () => {
    expect(mapCustomer({ customer_id: "hcp-3" }).ok).toBe(false);
  });

  it("gives an address a key stable enough to re-run against", () => {
    const first = mapCustomer({ customer_id: "x", first_name: "A", street: "9 Reply  Rd", zip: "75024" });
    const again = mapCustomer({ customer_id: "x", first_name: "A", street: "9 REPLY RD", zip: "75024" });
    if (!first.ok || !again.ok) throw new Error("expected both to map");
    expect(first.value.address?.hcpAddressId).toBe(again.value.address?.hcpAddressId);
  });
});

describe("mapJob", () => {
  it("maps a completed job", () => {
    const mapped = mapJob({
      job_id: "job-1",
      customer_id: "hcp-1",
      line_items: "Standard Clean",
      recurrence: "Every other week",
      total: "$170.00",
      status: "Completed",
      scheduled_start: "9/15/2026 10:00 AM",
    });

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.priceCents).toBe(17000);
    expect(mapped.value.frequency).toBe("biweekly");
    expect(mapped.value.status).toBe("complete");
    expect(mapped.value.completedAt).toBe("2026-09-15T10:00");
  });

  /**
   * Inferring a completion from a past date would make every old scheduled job
   * an incumbency, and continuity would hand houses to whoever was last
   * pencilled in.
   */
  it("gives a scheduled job no completion time however old it is", () => {
    const mapped = mapJob({
      job_id: "job-2",
      customer_id: "hcp-1",
      total: "170",
      status: "Scheduled",
      scheduled_start: "1/2/2020 10:00 AM",
    });
    if (!mapped.ok) throw new Error("expected it to map");
    expect(mapped.value.completedAt).toBeNull();
  });

  it("refuses a job whose price cannot be read", () => {
    const mapped = mapJob({ job_id: "job-3", customer_id: "hcp-1", total: "see invoice" });
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.problem).toContain("no readable price");
  });

  it("refuses a job with no customer", () => {
    expect(mapJob({ job_id: "job-4", total: "170" }).ok).toBe(false);
  });
});

/**
 * The real export, as it actually arrived.
 *
 * Every case below is something the September 2026 Housecall Pro export does
 * that this mapper was not originally written for, and each one was found by
 * the dry run rather than by reading the documentation — because the
 * documentation describes an export that is not the one the dashboard writes.
 */
describe("the shape a real HCP export arrives in", () => {
  /** The jobs export writes ids as `="1068"` so Excel does not reformat them. */
  it("reads a job id out of a spreadsheet escape", () => {
    const [row] = toRecords(parseCsv('Job #,Customer name\n"=""1068""",Dana Reyes\n'));
    expect(row?.["job"]).toBe("1068");

    const mapped = mapJob({ ...row!, total_service_price: "$130.00" });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.hcpId).toBe("1068");
  });

  /**
   * THE ONE THAT MADE EVERY JOB FAIL. The jobs export carries no customer id at
   * all — only a name, an email and a phone.
   */
  it("finds the customer by what the jobs file actually carries", () => {
    const keys = customerKeys({
      customer_name: "Dana  REYES",
      customer_email: "Dana@Example.com",
      customer_mobile_number: "+1 (214) 555-0143",
    });

    expect(keys.hcpId).toBeNull();
    expect(keys.displayName).toBe("dana reyes");
    expect(keys.email).toBe("dana@example.com");
    expect(keys.phone).toBe("2145550143");
  });

  it("reduces a phone to the ten digits both files agree on", () => {
    expect(normalisePhone("(214) 555-0143")).toBe("2145550143");
    expect(normalisePhone("+12145550143")).toBe("2145550143");
    expect(normalisePhone("555-0143")).toBeNull();
  });

  /**
   * A property manager with one billing email and a customer record per unit.
   * Matching on the email would file half their cleans against the wrong flat,
   * so the display name — which carries the unit number — is tried first.
   */
  it("keeps the unit number, which is the only thing telling two units apart", () => {
    const a = customerKeys({
      customer_name: "Bexley Grapevine 3535 Bluffs Ln #14214",
      customer_email: "service@switchplace.com",
    });
    const b = customerKeys({
      customer_name: "Bexley Grapevine 3535 Bluffs Ln #17209",
      customer_email: "service@switchplace.com",
    });

    expect(a.displayName).not.toBe(b.displayName);
    expect(a.email).toBe(b.email);
  });

  it("takes the address off the job row, where the cleaner was actually sent", () => {
    const mapped = mapJob({
      job: "5",
      customer_email: "dana@example.com",
      total_service_price: "$130.00",
      street: "9 Reply  Rd",
      street_2: "Apt 4",
      city: "Plano",
      state: "TX",
      zipcode: "75024",
    });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.address?.street).toBe("9 Reply  Rd Apt 4");
    expect(mapped.value.address?.zip).toBe("75024");
  });

  /** A property is a place. Two visits to one house are not two houses. */
  it("gives two visits to the same house one property key", () => {
    const address = { customer_email: "d@e.com", total_service_price: "$1", street: "9 Reply Rd", zipcode: "75024" };
    const first = mapJob({ ...address, job: "1" });
    const again = mapJob({ ...address, job: "2", street: "9  REPLY  RD" });
    if (!first.ok || !again.ok) throw new Error("expected both to map");
    expect(first.value.address?.hcpAddressId).toBe(again.value.address?.hcpAddressId);
  });

  /**
   * The export states the offset, which makes the value an absolute instant.
   * Discarding it and re-reading the wall clock as Dallas happens to round-trip
   * while the offset IS Dallas's, and shifts every row the moment it is not.
   */
  it("keeps an offset the export stated, summer and winter alike", () => {
    expect(parseExportDate("2024-05-27T21:30:00-05:00")).toEqual({
      date: "2024-05-27",
      time: "21:30",
      offset: "-05:00",
    });
    expect(parseExportDate("2022-02-11T08:00:00-06:00")?.offset).toBe("-06:00");
    expect(parseExportDate("2024-05-27T21:30:00Z")?.offset).toBe("+00:00");
    expect(parseExportDate("2024-05-27T21:30:00-0500")?.offset).toBe("-05:00");
  });

  it("carries that offset through to the mapped job, so the instant is unambiguous", () => {
    const mapped = mapJob({
      job: "7",
      customer_email: "d@e.com",
      total_service_price: "$130.00",
      job_scheduled_start_date: "2022-02-11T08:00:00-06:00",
      job_status: "Completed",
    });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.scheduledStart).toBe("2022-02-11T08:00-06:00");
    expect(new Date(mapped.value.scheduledStart!).toISOString()).toBe("2022-02-11T14:00:00.000Z");
  });

  /** A date with no offset stays wall clock, for the caller to resolve. */
  it("does not invent an offset the export did not state", () => {
    const mapped = mapJob({
      job: "8",
      customer_email: "d@e.com",
      total_service_price: "$130.00",
      scheduled_start: "9/15/2026 10:00 AM",
    });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.scheduledStart).toBe("2026-09-15T10:00");
  });

  it("reads the cadence out of the job tags, which is where it lives", () => {
    const mapped = mapJob({
      job: "9",
      customer_email: "d@e.com",
      total_service_price: "$130.00",
      job_tags: "Biweekly, complete",
    });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.frequency).toBe("biweekly");
  });

  /**
   * "2x a week" contains "week". Reading it as weekly halves that customer's
   * visits and points a re-quote at the wrong column of the price book — so it
   * is reported as unmappable rather than rounded to the nearest thing that
   * parses.
   */
  it("refuses a cadence the price book cannot sell, rather than calling it weekly", () => {
    expect(mapFrequency("2x a week")).toBeNull();
    expect(mapFrequency("twice a week")).toBeNull();
    expect(mapFrequency("3 x per week")).toBeNull();
    expect(hasUnsupportedCadence("2x a week")).toBe(true);
    expect(hasUnsupportedCadence("Biweekly")).toBe(false);
    expect(hasUnsupportedCadence(null)).toBe(false);

    const mapped = mapJob({
      job: "10",
      customer_email: "d@e.com",
      total_service_price: "$130.00",
      job_tags: "2x a week, complete",
    });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.cadenceUnsupported).toBe(true);
  });

  it("reads the customer file's own numbered address columns", () => {
    const mapped = mapCustomer({
      id: "126637495",
      first_name: "Dana",
      last_name: "Reyes",
      display_name: "Dana Reyes",
      address_1_street_line_1: "9 Reply Rd",
      address_1_city: "Plano",
      address_1_state: "TX",
      address_1_postal_code: "75024",
    });
    if (!mapped.ok) throw new Error(mapped.problem);
    expect(mapped.value.address?.street).toBe("9 Reply Rd");
    expect(mapped.value.address?.city).toBe("Plano");
    expect(mapped.value.displayName).toBe("dana reyes");
  });

  it("refuses a job with nothing at all identifying its customer", () => {
    const mapped = mapJob({ job: "11", total_service_price: "$130.00" });
    expect(mapped.ok).toBe(false);
  });
});
