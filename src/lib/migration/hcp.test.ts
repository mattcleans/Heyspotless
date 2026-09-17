import { describe, expect, it } from "vitest";
import {
  mapCustomer,
  mapFrequency,
  mapJob,
  mapJobStatus,
  mapService,
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
    expect(parseExportDate("2026-09-17 10:00")).toEqual({ date: "2026-09-17", time: "10:00" });
    expect(parseExportDate("2026-09-17")).toEqual({ date: "2026-09-17", time: null });
  });

  it("reads the US format the dashboard exports", () => {
    expect(parseExportDate("9/17/2026 10:00 AM")).toEqual({ date: "2026-09-17", time: "10:00" });
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
